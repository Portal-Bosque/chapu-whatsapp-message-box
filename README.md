# Chapu Message Box

Prototipo artesanal de una caja de mensajes de voz sin pantalla. Un ESP32-S3
controla un speakerphone USB EMEET y botones arcade; una aplicación Next.js
recibe y entrega los audios y usa `wacli` como puente local con WhatsApp.

## Qué incluye

- Panel web que replica los controles físicos de Chapu.
- Grabación desde el navegador y desde el EMEET.
- Cola de mensajes entrantes con indicador de mensajes pendientes.
- Envío y recepción de notas de voz mediante `wacli`.
- Agenda editable y números ocultos en la interfaz.
- Estado del ESP32, parlante y micrófono USB.
- Firmware reproducible en `firmware/esp32`.

## Aplicación web

Requiere Node.js y `wacli` instalado en la Mac.

```bash
npm install
npm run dev
```

La interfaz queda disponible en `http://localhost:3000` y en la red local de la
Mac. El primer inicio crea los archivos de datos locales dentro de `data/`.

## Firmware

Las instrucciones de configuración, compilación y carga están en
[`firmware/esp32/README.md`](firmware/esp32/README.md). Las credenciales Wi-Fi
se guardan únicamente en `firmware/esp32/main/wifi_secrets.h`, que Git ignora.

## Datos privados

El repositorio no incluye sesiones de WhatsApp, audios, números configurados,
credenciales Wi-Fi ni direcciones locales. Estos datos permanecen en `data/` y
en el archivo local de secretos del firmware.

## API principal

- `POST /api/recordings`: recibe audio WAV del ESP32.
- `GET /api/recordings`: lista las grabaciones locales.
- `GET /api/recordings/:id`: entrega audio con soporte de Range.
- `GET /api/outbox`: administra la cola destinada al EMEET.
- `POST /api/device/status`: recibe el heartbeat del ESP32.
- `/api/whatsapp/*`: autenticación, estado y recepción mediante `wacli`.
