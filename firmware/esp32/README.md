# Firmware ESP32-S3

Firmware de Chapu para una placa ESP32-S3 N16R8 con USB host. Controla el
speakerphone EMEET, graba audio, reproduce mensajes remotos y reporta el estado
del dispositivo a la aplicación web.

## Configuración

1. Copiar `main/wifi_secrets.example.h` como `main/wifi_secrets.h`.
2. Completar el SSID, contraseña y la IP local de la Mac que ejecuta la web en
   todas las URLs, incluida `MESSAGE_BOX_DEVICE_NAMES_URL`.
3. No subir `wifi_secrets.h`: está excluido por Git.

## Panel de botones

La caja usa seis botones arcade EG STARTS con lámpara LED. Cada botón ocupa dos
pines contiguos del header superior de la placa YD-ESP32-S3: uno para el
microswitch y otro para la lámpara.

| Botón     | Microswitch (NO) | Lámpara (señal) | Comportamiento de la lámpara                          |
|-----------|------------------|-----------------|-------------------------------------------------------|
| Mandar    | GPIO 4           | GPIO 5          | Titila mientras graba                                 |
| Recibir   | GPIO 6           | GPIO 7          | Titila con mensajes por escuchar, fija mientras suena |
| Agenda 1  | GPIO 15          | GPIO 16         | Fija cuando es el destinatario elegido                |
| Agenda 2  | GPIO 17          | GPIO 18         | Fija cuando es el destinatario elegido                |
| Agenda 3  | GPIO 10          | GPIO 11         | Fija cuando es el destinatario elegido                |
| Agenda 4  | GPIO 12          | GPIO 13         | Fija cuando es el destinatario elegido                |

Microswitch: `COM` a `GND` y `NO` al GPIO del botón. El firmware activa el
pull-up interno, así que una pulsación se lee en bajo. No hace falta resistencia.

Lámpara: el GPIO no alimenta el LED directamente. Va a la entrada de un driver
(el módulo MOSFET que ya está conectado en el botón de mandar, o un canal de un
ULN2003A para los seis botones) y el driver conmuta la lámpara contra su fuente.
GPIO en alto enciende la lámpara. Con un ULN2003A:

- `IN1..IN6` a los GPIO de lámpara de la tabla.
- `OUT1..OUT6` al negativo de cada lámpara.
- Positivo de cada lámpara a la tensión de la lámpara (5 V del pin `5V` de la
  placa si los botones son de 5 V, o una fuente de 12 V si son de 12 V).
- `GND` del ULN2003A a `GND` de la placa, y también a la fuente de 12 V si se usa.

Los pines evitados a propósito: 0, 3, 45 y 46 (strapping), 19 y 20 (USB host
hacia el EMEET), 35 a 37 (PSRAM) y 43 y 44 (consola serie).

La agenda se configura desde la web: el botón 1 es el primer contacto de la
lista, el 2 el segundo y así hasta el cuarto. Al apretar un botón de agenda el
ESP32 lo informa en el próximo heartbeat y la web cambia el destinatario; si la
web cambia el destinatario, la lámpara sigue a la web.

## Particiones

`partitions.csv` reserva 3 MB para la aplicación (la tabla por defecto de 1 MB
quedó chica). PlatformIO la toma desde `board_build.partitions`.

## Compilar y cargar

Requiere PlatformIO:

```bash
pio run
pio run --target upload --upload-port /dev/cu.usbserial-XXXXXXXX
pio device monitor --baud 115200
```

El proyecto descarga `espressif/usb_host_uac` mediante el Component Manager de
ESP-IDF durante la primera compilación.

### Grabar desde otra máquina

Si la placa está conectada a la Mac que corre la web (y no a la que compila),
copiar `.pio/build/emeet_test/{bootloader,partitions,firmware}.bin` a
`firmware/esp32/bins/` en esa máquina y correr `firmware/esp32/flash.sh`.
Necesita `esptool` (por ejemplo en un venv en `~/.esptool-venv`).
