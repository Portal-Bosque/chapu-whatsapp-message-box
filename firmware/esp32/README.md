# Firmware ESP32-S3

Firmware de Chapu para una placa ESP32-S3 N16R8 con USB host. Controla el
speakerphone EMEET, graba audio, reproduce mensajes remotos y reporta el estado
del dispositivo a la aplicación web.

## Configuración

1. Copiar `main/wifi_secrets.example.h` como `main/wifi_secrets.h`.
2. Completar el SSID, contraseña y la IP local de la Mac que ejecuta la web.
3. No subir `wifi_secrets.h`: está excluido por Git.

## Compilar y cargar

Requiere PlatformIO:

```bash
pio run
pio run --target upload --upload-port /dev/cu.usbserial-XXXXXXXX
pio device monitor --baud 115200
```

El proyecto descarga `espressif/usb_host_uac` mediante el Component Manager de
ESP-IDF durante la primera compilación.
