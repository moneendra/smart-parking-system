// =====================================================================
//  Smart Parking System — device configuration  (edit this file only)
// =====================================================================
#pragma once

// ---------- Wi-Fi (2.4 GHz networks only — ESP32/ESP8266 limitation) ----------
#define WIFI_SSID      "YourWiFiName"
#define WIFI_PASSWORD  "YourWiFiPassword"

// ---------- Central server / MQTT broker ----------
// Run "ipconfig" (Windows) / "ifconfig" (Linux, Mac) on the PC running
// server.js and put its LAN IPv4 address here, e.g. "192.168.1.50".
#define MQTT_HOST      "192.168.1.50"
#define MQTT_PORT      1883

// Must match "mqtt.prefix" in config.json on the server.
#define MQTT_PREFIX    "smartparking/demo01"

// ---------- This parking slot ----------
// Every physical slot node gets a UNIQUE id: S1, S2, S3, ...
#define SLOT_ID        "S1"

// ---------- IR proximity sensor ----------
#define IR_SENSOR_PIN  13     // digital output of the IR module (e.g. FC-51 / LM393)
#define IR_ACTIVE_LOW  1      // 1 = module output goes LOW when an object is detected
                              //     (default for most 3-pin IR obstacle modules)
                              // 0 = module output goes HIGH on detection

// ---------- Indicators ----------
#define LED_PIN        2      // onboard LED: ON while the slot is booked
#define ENABLE_BUZZER  1      // 1 = short beep when a hand is placed on the sensor
#define BUZZER_PIN     26     // active buzzer (+)

// ---------- I2C LCD 16x2 (optional, set to 1 when wired) ----------
#define ENABLE_LCD     0
#define LCD_ADDR       0x27   // typical addresses: 0x27 or 0x3F
#define LCD_COLS       16
#define LCD_ROWS       2

// ---------- Behaviour tuning ----------
#define STABLE_MS      300    // sensor must read the same level this long to count
                              // as a real state change (debounce)
#define HEARTBEAT_MS   30000  // re-publish status every 30 s (proves "online")
