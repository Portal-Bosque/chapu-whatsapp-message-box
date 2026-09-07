#!/bin/sh
# Flashes the prebuilt firmware in ./bins to the ESP32-S3 with esptool.
# Build on the laptop with PlatformIO, copy the three files to bins/, then run
# this from the machine the board is plugged into (needs esptool on PATH or in
# ~/.esptool-venv). Same arguments PlatformIO uses.
set -eu
cd "$(dirname "$0")"
PORT="${1:-$(ls /dev/cu.usbserial-* /dev/cu.usbmodem* /dev/cu.wchusbserial* 2>/dev/null | head -1)}"
[ -n "$PORT" ] || { echo "No serial port found; plug the ESP32 COM port in or pass it as an argument" >&2; exit 1; }
ESPTOOL="$(command -v esptool.py || command -v esptool || echo "$HOME/.esptool-venv/bin/esptool.py")"
echo "Flashing with $ESPTOOL on $PORT"
"$ESPTOOL" --chip esp32s3 --port "$PORT" --baud 460800 --before default_reset --after hard_reset \
  write_flash -z --flash_mode dio --flash_freq 80m --flash_size 8MB \
  0x0 bins/bootloader.bin 0x10000 bins/partitions.bin 0x20000 bins/firmware.bin
