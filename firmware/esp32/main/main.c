/*
 * SPDX-FileCopyrightText: 2024-2025 Espressif Systems (Shanghai) CO LTD
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <string.h>
#include <math.h>
#include <stdlib.h>
#include <inttypes.h>
#include <stdbool.h>
#include "sdkconfig.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "esp_err.h"
#include "esp_check.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "driver/gpio.h"
#include "nvs_flash.h"
#include "usb/usb_host.h"
#include "usb/uac_host.h"
#include "wifi_secrets.h"

static const char *TAG = "usb_audio_player";
static bool s_wifi_ready = false;

#define MIC_RECORD_MAX_SECONDS 120
#define RECORD_BUTTON_GPIO GPIO_NUM_4
#define RECORD_LED_GPIO GPIO_NUM_5
#define RECORD_BUTTON_DEBOUNCE_MS 50
#define RECORD_LED_BLINK_MS 350

static void wifi_event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data)
{
    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        ESP_LOGI(TAG, "Wi-Fi started; connecting to %s", MESSAGE_BOX_WIFI_SSID);
        esp_wifi_connect();
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        s_wifi_ready = false;
        ESP_LOGW(TAG, "Wi-Fi disconnected; reconnecting");
        esp_wifi_connect();
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        const ip_event_got_ip_t *event = (const ip_event_got_ip_t *)event_data;
        s_wifi_ready = true;
        ESP_LOGI(TAG, "Wi-Fi connected; ESP32 address: " IPSTR, IP2STR(&event->ip_info.ip));
    }
}

static void wifi_init_sta(void)
{
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    assert(esp_netif_create_default_wifi_sta() != NULL);

    wifi_init_config_t init_config = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init_config));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event_handler, NULL));

    wifi_config_t wifi_config = {0};
    strlcpy((char *)wifi_config.sta.ssid, MESSAGE_BOX_WIFI_SSID, sizeof(wifi_config.sta.ssid));
    strlcpy((char *)wifi_config.sta.password, MESSAGE_BOX_WIFI_PASSWORD, sizeof(wifi_config.sta.password));
    wifi_config.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
    wifi_config.sta.pmf_cfg.capable = true;
    wifi_config.sta.pmf_cfg.required = false;

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    ESP_ERROR_CHECK(esp_wifi_start());
}

static uint32_t get_fallback_sample_freq(const uac_host_dev_alt_param_t *alt_params, uint32_t preferred)
{
    if (alt_params->sample_freq_type > 0) {
        return alt_params->sample_freq[0];
    }

    uint32_t lower = alt_params->sample_freq_lower;
    uint32_t upper = alt_params->sample_freq_upper;

    if (lower == 0 && upper == 0) {
        return 0;
    }
    if (lower == 0) {
        return upper;
    }
    if (upper == 0) {
        return lower;
    }
    if (lower > upper) {
        uint32_t tmp = lower;
        lower = upper;
        upper = tmp;
    }

    if (preferred == 0 || preferred < lower) {
        return lower;
    }
    if (preferred > upper) {
        return upper;
    }
    return preferred;
}

static bool find_dev_alt_params_for_freq(uac_host_device_handle_t handle, uint32_t freq,
                                         uac_host_dev_alt_param_t *out)
{
    uac_host_dev_info_t info;
    if (uac_host_get_device_info(handle, &info) != ESP_OK) {
        return false;
    }
    for (uint8_t alt = 1; alt <= info.iface_alt_num; alt++) {
        uac_host_dev_alt_param_t p;
        if (uac_host_get_device_alt_param(handle, alt, &p) != ESP_OK) {
            continue;
        }
        bool match = false;
        if (p.sample_freq_type > 0) {
            for (int i = 0; i < p.sample_freq_type; i++) {
                if (p.sample_freq[i] == freq) {
                    match = true;
                    break;
                }
            }
        } else {
            match = (freq >= p.sample_freq_lower && freq <= p.sample_freq_upper);
        }
        if (match) {
            *out = p;
            return true;
        }
    }
    return false;
}

#define USB_HOST_TASK_PRIORITY  5
#define UAC_TASK_PRIORITY       5
#define USER_TASK_PRIORITY      2

static QueueHandle_t s_event_queue = NULL;
static uac_host_device_handle_t s_spk_dev_handle = NULL;
static uac_host_device_handle_t s_mic_dev_handle = NULL;

// playback resources
static TaskHandle_t s_play_task_handle = NULL;
static uint8_t *s_remote_wav_buf = NULL;
static char s_remote_message_id[96] = {0};
static volatile bool s_remote_playing = false;
static volatile bool s_remote_playback_finished = false;
static volatile bool s_emeet_cycle_active = false;
static volatile bool s_recording_indicator = false;

// MIC recording resources
static uint8_t *s_mic_record_buf = NULL;
static size_t s_mic_record_buf_size = 0;     // total capacity
static size_t s_mic_record_wr = 0;           // captured bytes
static bool is_playing_back = false;
static bool s_mic_recording = false;         // recording state
static volatile bool s_stop_play_request = false; // request playback stop
static int16_t *s_beep_pcm = NULL;
static size_t s_beep_pcm_size = 0;
#ifndef CONFIG_EXAMPLE_MIC_PLAYBACK
extern const uint8_t message_box_test_pcm[];
extern const unsigned int message_box_test_pcm_len;
#endif

typedef struct {
    const uint8_t *pcm_ptr;
    size_t pcm_size;
    bool is_loop;
    bool convert_mono_16k_to_stereo_48k;
    void (*complete_cb)(void);
} player_config_t;

static void start_recording_cycle(void);
static void start_recording_after_beep(void);
static void stop_recording_cycle(void);
static void play_recording_after_stop_beep(void);
static void play_captured_recording(void);
static void recording_playback_done_cb(void);
static void remote_playback_done_cb(void);
static bool ensure_mic_record_buffer(void);

static void record_button_gpio_init(void)
{
    gpio_config_t button_config = {
        .pin_bit_mask = 1ULL << RECORD_BUTTON_GPIO,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&button_config));

    gpio_config_t led_config = {
        .pin_bit_mask = 1ULL << RECORD_LED_GPIO,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_ENABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&led_config));
    ESP_ERROR_CHECK(gpio_set_level(RECORD_LED_GPIO, 0));
}

static void record_button_task(void *arg)
{
    int raw_level = gpio_get_level(RECORD_BUTTON_GPIO);
    int stable_level = raw_level;
    TickType_t level_changed_at = xTaskGetTickCount();
    TickType_t next_led_toggle = level_changed_at;
    bool led_on = false;
    bool indicator_was_active = false;

    while (true) {
        TickType_t now = xTaskGetTickCount();
        int new_level = gpio_get_level(RECORD_BUTTON_GPIO);

        if (new_level != raw_level) {
            raw_level = new_level;
            level_changed_at = now;
        }

        if (raw_level != stable_level &&
                (now - level_changed_at) >= pdMS_TO_TICKS(RECORD_BUTTON_DEBOUNCE_MS)) {
            stable_level = raw_level;

            // COM is wired to GND and NO to GPIO4, so a press reads LOW.
            if (stable_level == 0) {
                if (!s_emeet_cycle_active) {
                    if (s_spk_dev_handle == NULL || s_mic_dev_handle == NULL) {
                        ESP_LOGW(TAG, "Physical button ignored: EMEET is not ready");
                    } else if (s_play_task_handle != NULL || s_remote_playing) {
                        ESP_LOGW(TAG, "Physical button ignored: audio playback is active");
                    } else if (!ensure_mic_record_buffer()) {
                        ESP_LOGE(TAG, "Physical button could not allocate the recording buffer");
                    } else {
                        ESP_LOGI(TAG, "Physical button: start recording");
                        s_emeet_cycle_active = true;
                        start_recording_cycle();
                    }
                } else if (s_mic_recording) {
                    ESP_LOGI(TAG, "Physical button: stop recording and send");
                    stop_recording_cycle();
                } else {
                    ESP_LOGW(TAG, "Physical button ignored: message cycle is busy");
                }
            }
        }

        if (s_recording_indicator) {
            if (!indicator_was_active) {
                led_on = true;
                gpio_set_level(RECORD_LED_GPIO, 1);
                next_led_toggle = now + pdMS_TO_TICKS(RECORD_LED_BLINK_MS);
            } else if ((int32_t)(now - next_led_toggle) >= 0) {
                led_on = !led_on;
                gpio_set_level(RECORD_LED_GPIO, led_on ? 1 : 0);
                next_led_toggle = now + pdMS_TO_TICKS(RECORD_LED_BLINK_MS);
            }
        } else if (led_on || indicator_was_active) {
            led_on = false;
            gpio_set_level(RECORD_LED_GPIO, 0);
        }
        indicator_was_active = s_recording_indicator;

        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

static bool ensure_mic_record_buffer(void)
{
    if (s_mic_record_buf != NULL) {
        return true;
    }
    if (s_mic_record_buf_size == 0) {
        return false;
    }
    s_mic_record_buf = (uint8_t *)heap_caps_calloc(1, s_mic_record_buf_size,
                                                   MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (s_mic_record_buf == NULL) {
        ESP_LOGE(TAG, "Failed to allocate MIC record buffer (%u bytes)", (unsigned)s_mic_record_buf_size);
        return false;
    }
    return true;
}

static void pcm_play_task(void *arg)
{
    player_config_t *config = (player_config_t *)arg;
    size_t byte_offset = 0;
    const size_t chunk_bytes = 2048;
    ESP_LOGI(TAG, "PCM play task started");

    if (config->convert_mono_16k_to_stereo_48k) {
        // EMEET captures mono/16 kHz but its speaker accepts stereo/48 kHz.
        // Repeat each input sample three times and copy it to both channels.
        const size_t input_samples_per_chunk = 192;
        int16_t *converted = malloc(input_samples_per_chunk * 3 * 2 * sizeof(int16_t));
        if (converted == NULL) {
            ESP_LOGE(TAG, "Failed to allocate microphone conversion buffer");
            goto playback_done;
        }
        while (byte_offset < config->pcm_size && s_spk_dev_handle != NULL && !s_stop_play_request) {
            size_t samples = (config->pcm_size - byte_offset) / sizeof(int16_t);
            if (samples > input_samples_per_chunk) {
                samples = input_samples_per_chunk;
            }
            const int16_t *input = (const int16_t *)(config->pcm_ptr + byte_offset);
            size_t output_index = 0;
            for (size_t i = 0; i < samples; i++) {
                for (int repeat = 0; repeat < 3; repeat++) {
                    converted[output_index++] = input[i];
                    converted[output_index++] = input[i];
                }
            }
            size_t output_bytes = output_index * sizeof(int16_t);
            esp_err_t ret = uac_host_device_write(s_spk_dev_handle, (uint8_t *)converted, output_bytes, 1000);
            if (ret != ESP_OK) {
                ESP_LOGE(TAG, "uac_host_device_write failed: %s", esp_err_to_name(ret));
                break;
            }
            byte_offset += samples * sizeof(int16_t);
        }
        free(converted);
        ESP_LOGI(TAG, "Microphone playback completed");
        goto playback_done;
    }

    while (true) {
        if (s_spk_dev_handle == NULL || s_stop_play_request) {
            break;
        }
        size_t remaining = config->pcm_size - byte_offset;
        size_t bytes_to_write = remaining > chunk_bytes ? chunk_bytes : remaining;
        const uint8_t *buf = config->pcm_ptr + byte_offset;
        ESP_LOGI(TAG, "Writing %d bytes", bytes_to_write);
        esp_err_t ret = uac_host_device_write(s_spk_dev_handle, (void *)buf, bytes_to_write, 1000);
        if (ret != ESP_OK) {
            ESP_LOGE(TAG, "uac_host_device_write failed: %s", esp_err_to_name(ret));
            break;
        }
        byte_offset += bytes_to_write;
        if (byte_offset >= config->pcm_size) {
            if (!config->is_loop) {
                ESP_LOGI(TAG, "PCM playback completed");
                break;
            }
            byte_offset = 0; // loop
        }
    }
playback_done:
    s_play_task_handle = NULL;
    is_playing_back = false;
    if (config->complete_cb) {
        config->complete_cb();
    }
    vTaskDelete(NULL);
}

static esp_err_t start_pcm_playback(player_config_t *config)
{
    ESP_RETURN_ON_FALSE(config->pcm_ptr != NULL && config->pcm_size > 0, ESP_ERR_INVALID_ARG, TAG, "Invalid PCM config");
    static player_config_t s_player_config;
    if (s_play_task_handle == NULL) {
        s_player_config = *config;
        BaseType_t ret = xTaskCreatePinnedToCore(pcm_play_task, "pcm_play", 4096, (void *)&s_player_config, USER_TASK_PRIORITY, &s_play_task_handle, 0);
        if (ret != pdTRUE) {
            ESP_LOGE(TAG, "Failed to create PCM play task");
            return ESP_FAIL;
        }
    }
    return ESP_OK;
}

static void prepare_low_beep(void)
{
    const uint32_t sample_rate = 48000;
    const uint32_t duration_ms = 250;
    const uint32_t frames = sample_rate * duration_ms / 1000;
    const uint32_t ramp_frames = sample_rate / 100; // 10 ms fade at each end
    s_beep_pcm_size = frames * 2 * sizeof(int16_t);
    s_beep_pcm = malloc(s_beep_pcm_size);
    assert(s_beep_pcm != NULL);

    for (uint32_t frame = 0; frame < frames; frame++) {
        float envelope = 1.0f;
        if (frame < ramp_frames) {
            envelope = (float)frame / ramp_frames;
        } else if (frame >= frames - ramp_frames) {
            envelope = (float)(frames - frame - 1) / ramp_frames;
        }
        int16_t sample = (int16_t)(10000.0f * envelope * sinf(2.0f * 3.14159265f * 220.0f * frame / sample_rate));
        s_beep_pcm[frame * 2] = sample;
        s_beep_pcm[frame * 2 + 1] = sample;
    }
}

static void start_recording_cycle(void)
{
    if (s_spk_dev_handle == NULL || s_mic_dev_handle == NULL || s_beep_pcm == NULL || s_play_task_handle != NULL) {
        ESP_LOGW(TAG, "Could not start recording: audio device is busy or unavailable");
        s_recording_indicator = false;
        s_emeet_cycle_active = false;
        return;
    }
    ESP_LOGI(TAG, "Start beep");
    player_config_t beep = {
        .pcm_ptr = (const uint8_t *)s_beep_pcm,
        .pcm_size = s_beep_pcm_size,
        .complete_cb = start_recording_after_beep,
    };
    if (start_pcm_playback(&beep) != ESP_OK) {
        ESP_LOGE(TAG, "Could not play the start-recording beep");
        s_recording_indicator = false;
        s_emeet_cycle_active = false;
    }
}

static void start_recording_after_beep(void)
{
    if (s_mic_dev_handle != NULL && uac_host_device_resume(s_mic_dev_handle) == ESP_OK) {
        s_mic_record_wr = 0;
        s_mic_recording = true;
        s_recording_indicator = true;
        ESP_LOGI(TAG, "Recording started");
    } else {
        ESP_LOGE(TAG, "Failed to resume MIC device");
        s_recording_indicator = false;
        s_emeet_cycle_active = false;
    }
}

static void stop_recording_cycle(void)
{
    if (!s_mic_recording || s_mic_dev_handle == NULL) {
        ESP_LOGW(TAG, "Stop requested while the microphone was not recording");
        return;
    }

    s_mic_recording = false;
    s_recording_indicator = false;
    uac_host_device_suspend(s_mic_dev_handle);
    ESP_LOGI(TAG, "Recording stopped at %u bytes", (unsigned)s_mic_record_wr);
    player_config_t stop_beep = {
        .pcm_ptr = (const uint8_t *)s_beep_pcm,
        .pcm_size = s_beep_pcm_size,
        .complete_cb = play_recording_after_stop_beep,
    };
    if (start_pcm_playback(&stop_beep) != ESP_OK) {
        play_recording_after_stop_beep();
    }
}

typedef struct __attribute__((packed)) {
    char riff[4];
    uint32_t riff_size;
    char wave[4];
    char fmt[4];
    uint32_t fmt_size;
    uint16_t audio_format;
    uint16_t channels;
    uint32_t sample_rate;
    uint32_t byte_rate;
    uint16_t block_align;
    uint16_t bits_per_sample;
    char data[4];
    uint32_t data_size;
} wav_header_t;

#define MAX_REMOTE_WAV_BYTES (4 * 1024 * 1024)

typedef struct {
    char message_id[sizeof(s_remote_message_id)];
} remote_http_context_t;

static esp_err_t remote_http_event_handler(esp_http_client_event_t *event)
{
    remote_http_context_t *context = (remote_http_context_t *)event->user_data;
    if (context != NULL && event->event_id == HTTP_EVENT_ON_HEADER &&
            event->header_key != NULL && event->header_value != NULL &&
            strcasecmp(event->header_key, "X-Message-ID") == 0) {
        strlcpy(context->message_id, event->header_value, sizeof(context->message_id));
    }
    return ESP_OK;
}

static bool parse_remote_wave(uint8_t *buffer, size_t buffer_size, const uint8_t **pcm, size_t *pcm_size)
{
    if (buffer_size < 12 || memcmp(buffer, "RIFF", 4) != 0 ||
            memcmp(buffer + 8, "WAVE", 4) != 0) {
        return false;
    }

    bool format_ok = false;
    const uint8_t *data = NULL;
    size_t data_size = 0;

    for (size_t offset = 12; offset + 8 <= buffer_size;) {
        const uint8_t *chunk = buffer + offset;
        uint32_t chunk_size = (uint32_t)chunk[4] |
                              ((uint32_t)chunk[5] << 8) |
                              ((uint32_t)chunk[6] << 16) |
                              ((uint32_t)chunk[7] << 24);
        size_t payload_offset = offset + 8;
        if (chunk_size > buffer_size - payload_offset) {
            return false;
        }

        if (memcmp(chunk, "fmt ", 4) == 0 && chunk_size >= 16) {
            const uint8_t *fmt = buffer + payload_offset;
            uint16_t audio_format = (uint16_t)fmt[0] | ((uint16_t)fmt[1] << 8);
            uint16_t channels = (uint16_t)fmt[2] | ((uint16_t)fmt[3] << 8);
            uint32_t sample_rate = (uint32_t)fmt[4] |
                                   ((uint32_t)fmt[5] << 8) |
                                   ((uint32_t)fmt[6] << 16) |
                                   ((uint32_t)fmt[7] << 24);
            uint16_t bits_per_sample = (uint16_t)fmt[14] | ((uint16_t)fmt[15] << 8);
            format_ok = audio_format == 1 && channels == 1 &&
                        sample_rate == 16000 && bits_per_sample == 16;
        } else if (memcmp(chunk, "data", 4) == 0) {
            data = buffer + payload_offset;
            data_size = chunk_size;
        }

        size_t padded_size = (size_t)chunk_size + (chunk_size & 1U);
        if (padded_size > buffer_size - payload_offset) {
            break;
        }
        offset = payload_offset + padded_size;
    }

    if (!format_ok || data == NULL || data_size == 0) {
        return false;
    }
    *pcm = data;
    *pcm_size = data_size;
    return true;
}

static esp_err_t acknowledge_remote_message(void)
{
    char url[256];
    int written = snprintf(url, sizeof(url), "%s/%s", MESSAGE_BOX_OUTBOX_URL, s_remote_message_id);
    if (written <= 0 || written >= sizeof(url)) {
        return ESP_ERR_INVALID_SIZE;
    }

    esp_http_client_config_t config = {
        .url = url,
        .method = HTTP_METHOD_DELETE,
        .timeout_ms = 5000,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == NULL) {
        return ESP_FAIL;
    }
    esp_err_t result = esp_http_client_perform(client);
    int status = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);
    if (result == ESP_OK && status == 404) {
        ESP_LOGI(TAG, "Message %s was already removed", s_remote_message_id);
        return ESP_OK;
    }
    if (result != ESP_OK || status < 200 || status >= 300) {
        ESP_LOGW(TAG, "Message acknowledgement failed: %s, HTTP %d", esp_err_to_name(result), status);
        return result == ESP_OK ? ESP_FAIL : result;
    }
    ESP_LOGI(TAG, "Message %s marked as played", s_remote_message_id);
    return ESP_OK;
}

static esp_err_t fetch_record_command(void)
{
    if (s_mic_dev_handle == NULL || s_beep_pcm == NULL) {
        return ESP_ERR_NOT_FOUND;
    }

    esp_http_client_config_t get_config = {
        .url = MESSAGE_BOX_RECORD_COMMAND_URL,
        .method = HTTP_METHOD_GET,
        .timeout_ms = 4000,
    };
    esp_http_client_handle_t client = esp_http_client_init(&get_config);
    if (client == NULL) {
        return ESP_FAIL;
    }
    esp_err_t result = esp_http_client_perform(client);
    int status = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);
    if (result != ESP_OK) {
        return result;
    }
    if (status == 204) {
        return ESP_ERR_NOT_FOUND;
    }
    if (status != 200 && status != 202) {
        return ESP_ERR_INVALID_RESPONSE;
    }
    const int command_status = status;

    esp_http_client_config_t delete_config = {
        .url = MESSAGE_BOX_RECORD_COMMAND_URL,
        .method = HTTP_METHOD_DELETE,
        .timeout_ms = 4000,
    };
    client = esp_http_client_init(&delete_config);
    if (client == NULL) {
        return ESP_FAIL;
    }
    result = esp_http_client_perform(client);
    status = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);
    if (result != ESP_OK || status < 200 || status >= 300) {
        return result == ESP_OK ? ESP_FAIL : result;
    }

    if (command_status == 200) {
        ESP_LOGI(TAG, "Start-recording command received from the web");
        if (!s_emeet_cycle_active) {
            if (!ensure_mic_record_buffer()) {
                return ESP_ERR_NO_MEM;
            }
            s_emeet_cycle_active = true;
            start_recording_cycle();
        }
    } else {
        ESP_LOGI(TAG, "Stop-recording command received from the web");
        if (s_emeet_cycle_active) {
            stop_recording_cycle();
        }
    }
    return ESP_OK;
}

static esp_err_t fetch_and_play_remote_message(void)
{
    char next_url[256];
    int written = snprintf(next_url, sizeof(next_url), "%s/next", MESSAGE_BOX_OUTBOX_URL);
    if (written <= 0 || written >= sizeof(next_url)) {
        return ESP_ERR_INVALID_SIZE;
    }

    remote_http_context_t context = {0};
    esp_http_client_config_t config = {
        .url = next_url,
        .method = HTTP_METHOD_GET,
        .timeout_ms = 8000,
        .event_handler = remote_http_event_handler,
        .user_data = &context,
        .buffer_size = 2048,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == NULL) {
        return ESP_FAIL;
    }

    esp_err_t result = esp_http_client_open(client, 0);
    int64_t content_length = -1;
    int status = 0;
    if (result == ESP_OK) {
        content_length = esp_http_client_fetch_headers(client);
        status = esp_http_client_get_status_code(client);
    }
    if (result != ESP_OK || status == 204) {
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return status == 204 ? ESP_ERR_NOT_FOUND : result;
    }
    if (status != 200 || content_length < (int64_t)sizeof(wav_header_t) ||
            content_length > MAX_REMOTE_WAV_BYTES || context.message_id[0] == '\0') {
        ESP_LOGW(TAG, "Invalid outbox response: HTTP %d, length %lld, id=%s",
                 status, content_length, context.message_id);
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return ESP_ERR_INVALID_RESPONSE;
    }

    // Recording and remote playback are mutually exclusive. Share their memory
    // budget so both directions work even before PSRAM is enabled.
    if (s_mic_record_buf != NULL) {
        free(s_mic_record_buf);
        s_mic_record_buf = NULL;
    }
    uint8_t *buffer = malloc((size_t)content_length);
    if (buffer == NULL) {
        ESP_LOGE(TAG, "Not enough memory for %lld-byte message", content_length);
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        ensure_mic_record_buffer();
        return ESP_ERR_NO_MEM;
    }

    size_t total = 0;
    while (total < (size_t)content_length) {
        int received = esp_http_client_read(client, (char *)buffer + total, (int)((size_t)content_length - total));
        if (received <= 0) {
            result = ESP_FAIL;
            break;
        }
        total += received;
    }
    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    if (result != ESP_OK || total != (size_t)content_length) {
        free(buffer);
        ensure_mic_record_buffer();
        return result == ESP_OK ? ESP_FAIL : result;
    }

    const uint8_t *pcm = NULL;
    size_t pcm_size = 0;
    if (!parse_remote_wave(buffer, total, &pcm, &pcm_size)) {
        ESP_LOGE(TAG, "The downloaded file is not PCM16 mono/16 kHz WAV");
        free(buffer);
        ensure_mic_record_buffer();
        return ESP_ERR_INVALID_RESPONSE;
    }

    s_remote_wav_buf = buffer;
    strlcpy(s_remote_message_id, context.message_id, sizeof(s_remote_message_id));
    s_remote_playing = true;
    player_config_t playback = {
        .pcm_ptr = pcm,
        .pcm_size = pcm_size,
        .convert_mono_16k_to_stereo_48k = true,
        .complete_cb = remote_playback_done_cb,
    };
    result = start_pcm_playback(&playback);
    if (result != ESP_OK) {
        free(s_remote_wav_buf);
        s_remote_wav_buf = NULL;
        s_remote_message_id[0] = '\0';
        s_remote_playing = false;
        ensure_mic_record_buffer();
        return result;
    }
    ESP_LOGI(TAG, "Playing web message %s (%u PCM bytes)", s_remote_message_id, (unsigned)pcm_size);
    return ESP_OK;
}

static void remote_playback_done_cb(void)
{
    s_remote_playback_finished = true;
}

static esp_err_t publish_device_status(void)
{
    char payload[112];
    int payload_size = snprintf(payload, sizeof(payload),
                                "{\"speaker\":%s,\"microphone\":%s,\"recording\":%s}",
                                s_spk_dev_handle != NULL ? "true" : "false",
                                s_mic_dev_handle != NULL ? "true" : "false",
                                s_mic_recording ? "true" : "false");
    if (payload_size <= 0 || payload_size >= sizeof(payload)) {
        return ESP_ERR_INVALID_SIZE;
    }

    esp_http_client_config_t config = {
        .url = MESSAGE_BOX_DEVICE_STATUS_URL,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 3000,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == NULL) {
        return ESP_FAIL;
    }
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_post_field(client, payload, payload_size);
    esp_err_t result = esp_http_client_perform(client);
    int status = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);
    if (result != ESP_OK) {
        return result;
    }
    return status >= 200 && status < 300 ? ESP_OK : ESP_ERR_INVALID_RESPONSE;
}

static void remote_messages_task(void *arg)
{
    TickType_t last_status_at = 0;
    while (true) {
        TickType_t now = xTaskGetTickCount();
        if (s_wifi_ready && (now - last_status_at >= pdMS_TO_TICKS(2000))) {
            publish_device_status();
            last_status_at = now;
        }
        if (s_remote_playback_finished) {
            if (acknowledge_remote_message() == ESP_OK) {
                free(s_remote_wav_buf);
                s_remote_wav_buf = NULL;
                s_remote_message_id[0] = '\0';
                s_remote_playback_finished = false;
                s_remote_playing = false;
                ensure_mic_record_buffer();
            }
        } else if (s_wifi_ready && s_spk_dev_handle != NULL && !s_remote_playing &&
                   s_play_task_handle == NULL) {
            esp_err_t command_result = fetch_record_command();
            if (command_result == ESP_ERR_NOT_FOUND && !s_emeet_cycle_active) {
                esp_err_t result = fetch_and_play_remote_message();
                if (result != ESP_OK && result != ESP_ERR_NOT_FOUND) {
                    ESP_LOGW(TAG, "Could not fetch the next web message: %s", esp_err_to_name(result));
                }
            } else if (command_result != ESP_OK) {
                ESP_LOGW(TAG, "Could not fetch the record command: %s", esp_err_to_name(command_result));
            }
        }
        vTaskDelay(pdMS_TO_TICKS(500));
    }
}

static bool http_write_all(esp_http_client_handle_t client, const uint8_t *data, size_t size)
{
    while (size > 0) {
        int chunk = size > 4096 ? 4096 : (int)size;
        int written = esp_http_client_write(client, (const char *)data, chunk);
        if (written <= 0) {
            return false;
        }
        data += written;
        size -= written;
    }
    return true;
}

static esp_err_t upload_captured_recording(void)
{
    if (!s_wifi_ready) {
        ESP_LOGW(TAG, "Wi-Fi is not ready; skipping upload");
        return ESP_ERR_INVALID_STATE;
    }

    const size_t recorded_size = s_mic_record_wr;
    if (recorded_size == 0) {
        ESP_LOGW(TAG, "No microphone samples were captured; skipping upload");
        return ESP_ERR_INVALID_SIZE;
    }

    wav_header_t header = {0};
    memcpy(header.riff, "RIFF", 4);
    memcpy(header.wave, "WAVE", 4);
    memcpy(header.fmt, "fmt ", 4);
    memcpy(header.data, "data", 4);
    header.riff_size = 36 + recorded_size;
    header.fmt_size = 16;
    header.audio_format = 1;
    header.channels = 1;
    header.sample_rate = 16000;
    header.byte_rate = 16000 * sizeof(int16_t);
    header.block_align = sizeof(int16_t);
    header.bits_per_sample = 16;
    header.data_size = recorded_size;

    esp_http_client_config_t config = {
        .url = MESSAGE_BOX_API_URL,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 60000,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == NULL) {
        return ESP_FAIL;
    }

    esp_http_client_set_header(client, "Content-Type", "audio/wav");
    esp_http_client_set_header(client, "X-Device-ID", "message-box-esp32");
    size_t request_size = sizeof(header) + recorded_size;
    esp_err_t result = esp_http_client_open(client, request_size);
    if (result == ESP_OK) {
        if (!http_write_all(client, (const uint8_t *)&header, sizeof(header)) ||
                !http_write_all(client, s_mic_record_buf, recorded_size)) {
            result = ESP_FAIL;
        } else if (esp_http_client_fetch_headers(client) < 0) {
            result = ESP_FAIL;
        } else {
            int status = esp_http_client_get_status_code(client);
            if (status < 200 || status >= 300) {
                ESP_LOGE(TAG, "Audio upload returned HTTP %d", status);
                result = ESP_FAIL;
            } else {
                ESP_LOGI(TAG, "Audio uploaded successfully: HTTP %d, %u bytes", status, (unsigned)request_size);
            }
        }
    }

    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    return result;
}

static void upload_recording_task(void *arg)
{
    esp_err_t result = upload_captured_recording();
    if (result != ESP_OK) {
        ESP_LOGE(TAG, "Audio upload failed: %s", esp_err_to_name(result));
    }
    s_recording_indicator = false;
    s_emeet_cycle_active = false;
    ESP_LOGI(TAG, "EMEET message cycle completed");
    vTaskDelete(NULL);
}

static void play_recording_after_stop_beep(void)
{
    BaseType_t created = xTaskCreatePinnedToCore(upload_recording_task, "audio_upload", 8192, NULL,
                                                 USER_TASK_PRIORITY, NULL, 1);
    if (created != pdTRUE) {
        ESP_LOGE(TAG, "Failed to create audio upload task");
        play_captured_recording();
    }
}

static void play_captured_recording(void)
{
    if (s_spk_dev_handle == NULL || s_mic_record_buf == NULL) {
        return;
    }
    ESP_LOGI(TAG, "Playing captured microphone audio");
    player_config_t recording = {
        .pcm_ptr = s_mic_record_buf,
        .pcm_size = s_mic_record_wr,
        .convert_mono_16k_to_stereo_48k = true,
        .complete_cb = recording_playback_done_cb,
    };
    start_pcm_playback(&recording);
}

static void recording_playback_done_cb(void)
{
    vTaskDelay(pdMS_TO_TICKS(750));
    start_recording_cycle();
}

/**
 * @brief event group
 *
 * UAC_DRIVER_EVENT     - UAC Host Driver event, such as device connection
 * UAC_DEVICE_EVENT     - UAC Host Device event, such as rx/tx completion, device disconnection
 */
typedef enum {
    UAC_DRIVER_EVENT,
    UAC_DEVICE_EVENT,
} event_group_t;

/**
 * @brief event queue
 *
 * This event is used for delivering the UAC Host event from callback to the uac_lib_task
 */
typedef struct {
    event_group_t event_group;
    union {
        struct {
            uint8_t addr;
            uint8_t iface_num;
            uac_host_driver_event_t event;
            void *arg;
        } driver_evt;
        struct {
            uac_host_device_handle_t handle;
            uac_host_device_event_t event;
            void *arg;
        } device_evt;
    };
} s_event_queue_t;

// removed audio_player dependent code

static void uac_device_callback(uac_host_device_handle_t uac_device_handle, const uac_host_device_event_t event, void *arg)
{
    // Send uac device event to the event queue
    s_event_queue_t evt_queue = {
        .event_group = UAC_DEVICE_EVENT,
        .device_evt.handle = uac_device_handle,
        .device_evt.event = event,
        .device_evt.arg = arg
    };
    // should not block here
    xQueueSend(s_event_queue, &evt_queue, 0);
}

static void uac_host_lib_callback(uint8_t addr, uint8_t iface_num, const uac_host_driver_event_t event, void *arg)
{
    // Send uac driver event to the event queue
    s_event_queue_t evt_queue = {
        .event_group = UAC_DRIVER_EVENT,
        .driver_evt.addr = addr,
        .driver_evt.iface_num = iface_num,
        .driver_evt.event = event,
        .driver_evt.arg = arg
    };
    xQueueSend(s_event_queue, &evt_queue, 0);
}

/**
 * @brief Start USB Host install and handle common USB host library events while app pin not low
 *
 * @param[in] arg  Not used
 */
static void usb_lib_task(void *arg)
{
    const usb_host_config_t host_config = {
        .skip_phy_setup = false,
        .intr_flags = ESP_INTR_FLAG_LOWMED,
    };

    ESP_ERROR_CHECK(usb_host_install(&host_config));
    ESP_LOGI(TAG, "USB Host installed");
    xTaskNotifyGive((TaskHandle_t)arg);

    while (true) {
        uint32_t event_flags;
        usb_host_lib_handle_events(portMAX_DELAY, &event_flags);
        // In this example, there is only one client registered
        // So, once we deregister the client, this call must succeed with ESP_OK
        if (event_flags & USB_HOST_LIB_EVENT_FLAGS_NO_CLIENTS) {
            ESP_ERROR_CHECK(usb_host_device_free_all());
            break;
        }
    }

    ESP_LOGI(TAG, "USB Host shutdown");
    // Clean up USB Host
    vTaskDelay(10); // Short delay to allow clients clean-up
    ESP_ERROR_CHECK(usb_host_uninstall());
    vTaskDelete(NULL);
}

static void uac_lib_task(void *arg)
{
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    uac_host_driver_config_t uac_config = {
        .create_background_task = true,
        .task_priority = UAC_TASK_PRIORITY,
        .stack_size = 4096,
        .core_id = 0,
        .callback = uac_host_lib_callback,
        .callback_arg = NULL
    };

    ESP_ERROR_CHECK(uac_host_install(&uac_config));
    ESP_LOGI(TAG, "UAC Class Driver installed");
    s_event_queue_t evt_queue = {0};
    while (1) {
        if (xQueueReceive(s_event_queue, &evt_queue, portMAX_DELAY)) {
            if (UAC_DRIVER_EVENT ==  evt_queue.event_group) {
                uac_host_driver_event_t event = evt_queue.driver_evt.event;
                uint8_t addr = evt_queue.driver_evt.addr;
                uint8_t iface_num = evt_queue.driver_evt.iface_num;
                switch (event) {
                case UAC_HOST_DRIVER_EVENT_TX_CONNECTED: {
                    uac_host_dev_info_t dev_info;
                    uac_host_device_handle_t uac_device_handle = NULL;
                    const uac_host_device_config_t dev_config = {
                        .addr = addr,
                        .iface_num = iface_num,
                        .buffer_size = 16000,
                        .buffer_threshold = 4000,
                        .callback = uac_device_callback,
                        .callback_arg = NULL,
                    };
                    ESP_ERROR_CHECK(uac_host_device_open(&dev_config, &uac_device_handle));
                    ESP_ERROR_CHECK(uac_host_get_device_info(uac_device_handle, &dev_info));
                    ESP_LOGI(TAG, "UAC Device connected: SPK");
                    uac_host_printf_device_param(uac_device_handle);
                    uac_host_dev_alt_param_t iface_alt_params;
                    uint32_t spk_freq = CONFIG_EXAMPLE_SPK_SAMPLE_FREQ;
                    if (spk_freq != 0 && find_dev_alt_params_for_freq(uac_device_handle, spk_freq, &iface_alt_params)) {
                        ESP_LOGI(TAG, "Found alt setting for %" PRIu32 " Hz", spk_freq);
                    } else {
                        if (spk_freq != 0) {
                            ESP_LOGW(TAG, "%" PRIu32 " Hz not found, using device default", spk_freq);
                        }
                        ESP_ERROR_CHECK(uac_host_get_device_alt_param(uac_device_handle, 1, &iface_alt_params));
                        spk_freq = get_fallback_sample_freq(&iface_alt_params, spk_freq);
                    }
                    uac_host_stream_config_t stm_config = {
                        .channels = iface_alt_params.channels,
                        .bit_resolution = iface_alt_params.bit_resolution,
                        .sample_freq = spk_freq,
                    };
                    ESP_LOGI(TAG, "Start UAC speaker with %"PRIu32" Hz, %u-byte subframe, %u bits, %s ",
                             stm_config.sample_freq, iface_alt_params.subframe_size, stm_config.bit_resolution, stm_config.channels == 1 ? "Mono" : "Stereo");
                    if (ESP_OK != uac_host_device_start(uac_device_handle, &stm_config)) {
                        ESP_LOGE(TAG, "Failed to start UAC device");
                        ESP_ERROR_CHECK(uac_host_device_close(uac_device_handle));
                        break;
                    }
                    s_spk_dev_handle = uac_device_handle;
                    uac_host_device_set_volume(uac_device_handle, 50); // set volume
                    uac_host_device_set_mute(uac_device_handle, false); // set mute off
                    ESP_LOGI(TAG, "Speaker ready; waiting for messages from the web");
                    break;
                }
                case UAC_HOST_DRIVER_EVENT_RX_CONNECTED: {
                    ESP_LOGI(TAG, "UAC Device connected: MIC");
                    uac_host_device_handle_t uac_device_handle = NULL;
                    const uint32_t rx_buffer_size = 19200;
                    const uac_host_device_config_t dev_config = {
                        .addr = addr,
                        .iface_num = iface_num,
                        .buffer_size = rx_buffer_size,
                        .callback = uac_device_callback,
                        .callback_arg = NULL,
                    };
                    ESP_ERROR_CHECK(uac_host_device_open(&dev_config, &uac_device_handle));
                    uac_host_dev_alt_param_t mic_alt_params;
                    uint32_t mic_freq = CONFIG_EXAMPLE_MIC_SAMPLE_FREQ;
                    if (mic_freq != 0 && find_dev_alt_params_for_freq(uac_device_handle, mic_freq, &mic_alt_params)) {
                        ESP_LOGI(TAG, "Found alt setting for MIC %" PRIu32 " Hz", mic_freq);
                    } else {
                        ESP_ERROR_CHECK(uac_host_get_device_alt_param(uac_device_handle, 1, &mic_alt_params));
                        mic_freq = get_fallback_sample_freq(&mic_alt_params, mic_freq);
                    }
                    const uac_host_stream_config_t mic_stream_config = {
                        .channels = mic_alt_params.channels,
                        .bit_resolution = mic_alt_params.bit_resolution,
                        .sample_freq = mic_freq,
                    };
                    ESP_LOGI(TAG, "Start UAC microphone with %"PRIu32" Hz, %u bits, channels=%u",
                             mic_stream_config.sample_freq,
                             mic_stream_config.bit_resolution,
                             mic_stream_config.channels);
                    if (ESP_OK != uac_host_device_start(uac_device_handle, &mic_stream_config)) {
                        ESP_LOGE(TAG, "Failed to start UAC microphone");
                        ESP_ERROR_CHECK(uac_host_device_close(uac_device_handle));
                        break;
                    }
                    s_mic_dev_handle = uac_device_handle;
                    if (s_mic_record_buf_size == 0) {
                        uint32_t bytes_per_sec = mic_stream_config.sample_freq * mic_stream_config.channels * mic_alt_params.subframe_size;
                        s_mic_record_buf_size = bytes_per_sec * MIC_RECORD_MAX_SECONDS;
                        ESP_LOGI(TAG, "Recording capacity: %u seconds (%u bytes in PSRAM)",
                                 MIC_RECORD_MAX_SECONDS, (unsigned)s_mic_record_buf_size);
                    }
                    if (!ensure_mic_record_buffer()) {
                        ESP_ERROR_CHECK(uac_host_device_close(uac_device_handle));
                        s_mic_dev_handle = NULL;
                        break;
                    }
                    s_mic_record_wr = 0;
                    s_mic_recording = false;
                    ESP_ERROR_CHECK(uac_host_device_suspend(s_mic_dev_handle));
                    ESP_LOGI(TAG, "Microphone ready and paused; waiting for a web command");
                    break;
                }
                default:
                    break;
                }
            } else if (UAC_DEVICE_EVENT == evt_queue.event_group) {
                uac_host_device_event_t event = evt_queue.device_evt.event;
                switch (event) {
                case UAC_HOST_DRIVER_EVENT_DISCONNECTED: {
                    ESP_LOGI(TAG, "UAC Device disconnected");
                    uac_host_device_handle_t handle = evt_queue.device_evt.handle;
                    if (handle == s_spk_dev_handle) {
                        s_spk_dev_handle = NULL;
                    } else if (handle == s_mic_dev_handle) {
                        s_mic_dev_handle = NULL;
                        s_mic_recording = false;
                        s_recording_indicator = false;
                        s_emeet_cycle_active = false;
                        // Stop playback if it's running
                        if (s_play_task_handle) {
                            s_stop_play_request = true;
                            while (s_play_task_handle) {
                                vTaskDelay(pdMS_TO_TICKS(10));
                            }
                            s_stop_play_request = false;
                        }
                        if (s_mic_record_buf) {
                            free(s_mic_record_buf);
                            s_mic_record_buf = NULL;
                        }
                        s_mic_record_buf_size = 0;
                        s_mic_record_wr = 0;
                    }
                    ESP_ERROR_CHECK(uac_host_device_close(handle));
                    break;
                }
                case UAC_HOST_DEVICE_EVENT_RX_DONE:
                    if (s_mic_dev_handle && s_mic_record_buf && s_mic_recording) {
                        uint32_t rx_size = 0;
                        uac_host_device_read(s_mic_dev_handle, s_mic_record_buf + s_mic_record_wr, s_mic_record_buf_size - s_mic_record_wr, &rx_size, 0);
                        ESP_LOGI(TAG, "Reading MIC %"PRIu32" bytes", rx_size);
                        s_mic_record_wr += rx_size;
                        if (s_mic_record_wr >= s_mic_record_buf_size) {
                            if (s_spk_dev_handle != NULL) {
                                ESP_LOGW(TAG, "Recording reached the %d-second safety limit", MIC_RECORD_MAX_SECONDS);
                                stop_recording_cycle();
                            } else {
                                s_mic_record_wr = 0;
                            }
                        }
                    }
                    break;
                case UAC_HOST_DEVICE_EVENT_TX_DONE:
                    break;
                case UAC_HOST_DEVICE_EVENT_TRANSFER_ERROR:
                    break;
                default:
                    break;
                }
            }
        }
    }
}

void app_main(void)
{
    record_button_gpio_init();
    wifi_init_sta();
    prepare_low_beep();
    s_event_queue = xQueueCreate(10, sizeof(s_event_queue_t));
    assert(s_event_queue != NULL);

    static TaskHandle_t uac_task_handle = NULL;
    BaseType_t ret = xTaskCreatePinnedToCore(uac_lib_task, "uac_events", 4096, NULL,
                                             USER_TASK_PRIORITY, &uac_task_handle, 0);
    assert(ret == pdTRUE);
    ret = xTaskCreatePinnedToCore(usb_lib_task, "usb_events", 4096, (void *)uac_task_handle,
                                  USB_HOST_TASK_PRIORITY, NULL, 0);
    assert(ret == pdTRUE);
    ret = xTaskCreatePinnedToCore(remote_messages_task, "remote_messages", 6144, NULL,
                                  USER_TASK_PRIORITY, NULL, 1);
    assert(ret == pdTRUE);
    ret = xTaskCreatePinnedToCore(record_button_task, "record_button", 3072, NULL,
                                  USER_TASK_PRIORITY, NULL, 1);
    assert(ret == pdTRUE);
}
