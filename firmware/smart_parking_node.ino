/*
 * =====================================================================
 *  Smart Parking System — ESP32/ESP8266 IR slot node
 * =====================================================================
 *  A hand (or car) placed over the IR proximity sensor = slot BOOKED.
 *  On every occupancy change the node publishes to the central server:
 *
 *    MQTT_PREFIX/slot/SLOT_ID/status  (retained)
 *      {"slot":"S1","occupied":true,"deviceTimeMs":123456,"seq":7}
 *
 *    MQTT_PREFIX/slot/SLOT_ID/availability  (retained, LWT = "offline")
 *      "online" | "offline"
 *
 *  It also subscribes to .../cmd — send "ping" to force a status publish.
 *
 *  Board:  ESP32 Dev Module (or ESP8266 / NodeMCU / Wemos D1 mini)
 *  Libs:   PubSubClient by Nick O'Leary  (Library Manager)
 *          LiquidCrystal_I2C by Frank de Brabander (only if ENABLE_LCD 1)
 *
 *  Edit config.h first: Wi-Fi, server IP, slot id.
 * =====================================================================
 */

#if defined(ESP32)
  #include <WiFi.h>
#elif defined(ESP8266)
  #include <ESP8266WiFi.h>
#else
  #error "This sketch targets ESP32 or ESP8266 boards."
#endif

#include <PubSubClient.h>
#include "config.h"

#if ENABLE_LCD
  #include <Wire.h>
  #include <LiquidCrystal_I2C.h>
  LiquidCrystal_I2C lcd(LCD_ADDR, LCD_COLS, LCD_ROWS);
#endif

WiFiClient    net;
PubSubClient  mqtt(net);

const uint8_t ACTIVE_LEVEL = IR_ACTIVE_LOW ? LOW : HIGH;  // level = "object detected"

char topicStatus[96];
char topicAvail[96];
char topicCmd[96];
char clientId[40];

void buildTopics() {
  snprintf(topicStatus, sizeof(topicStatus), "%s/slot/%s/status",       MQTT_PREFIX, SLOT_ID);
  snprintf(topicAvail,  sizeof(topicAvail),  "%s/slot/%s/availability", MQTT_PREFIX, SLOT_ID);
  snprintf(topicCmd,    sizeof(topicCmd),    "%s/slot/%s/cmd",          MQTT_PREFIX, SLOT_ID);
#if defined(ESP32)
  uint32_t chip = (uint32_t)(ESP.getEfuseMac() & 0xFFFFFF);
#else
  uint32_t chip = ESP.getChipId();
#endif
  snprintf(clientId,    sizeof(clientId),    "park-%s-%06X", SLOT_ID, chip);
}

bool          occupied = false;        // current published state
bool          lastRaw   = false;       // last raw sensor reading (for debounce)
unsigned long rawChangeMs = 0;         // when the raw reading last changed
unsigned long occupancyStartMs = 0;    // millis() when the hand was placed
unsigned long freeStartMs = 0;         // millis() when the hand was removed
unsigned long lastHeartbeatMs = 0;
unsigned long lastMqttTryMs   = 0;
unsigned long lastWifiTryMs   = 0;
unsigned long lastLcdMs       = 0;
unsigned long beepUntilMs     = 0;
unsigned long seq             = 0;

/* ------------------------------------------------------------------ */
bool irDetected() { return digitalRead(IR_SENSOR_PIN) == ACTIVE_LEVEL; }

void fmtElapsed(unsigned long ms, char *out, size_t n) {
  unsigned long s = ms / 1000;
  snprintf(out, n, "%02lu:%02lu:%02lu", s / 3600, (s / 60) % 60, s % 60);
}

/* ------------------------------------------------------------------ */
void updateLcd() {
#if ENABLE_LCD
  char line[LCD_COLS + 1];
  char t[12];

  snprintf(line, sizeof(line), "S%s %s", SLOT_ID, occupied ? "BOOKED" : "FREE");
  lcd.setCursor(0, 0);
  lcd.print(line);
  lcd.print(WiFi.status() == WL_CONNECTED && mqtt.connected() ? "  * " : "  x "); // * = link ok

  if (occupied) {
    fmtElapsed(millis() - occupancyStartMs, t, sizeof(t));   // live booking timer
    snprintf(line, sizeof(line), "Time %s", t);
  } else {
    fmtElapsed(millis() - freeStartMs, t, sizeof(t));        // time since freed
    snprintf(line, sizeof(line), "Free %s", t);
  }
  lcd.setCursor(0, 1);
  lcd.print(line);
  for (uint8_t i = strlen(line); i < LCD_COLS; i++) lcd.print(' ');
#endif
}

void publishStatus() {
  seq++;
  char payload[96];
  // deviceTimeMs = device uptime; the server stamps the authoritative wall-clock time
  snprintf(payload, sizeof(payload),
           "{\"slot\":\"%s\",\"occupied\":%s,\"deviceTimeMs\":%lu,\"seq\":%lu}",
           SLOT_ID, occupied ? "true" : "false", (unsigned long)millis(), (unsigned long)seq);
  bool ok = mqtt.publish(topicStatus, payload, true);
  Serial.printf("[MQTT] %s %s (%s)\n", topicStatus, payload, ok ? "sent" : "FAILED");
}

void onStateChange(bool nowOccupied) {
  occupied = nowOccupied;

  if (occupied) {
    occupancyStartMs = millis();
#if ENABLE_BUZZER
    beepUntilMs = millis() + 150;          // short beep: hand placed
#endif
    Serial.println("[SENS] hand placed on sensor  ->  BOOKED");
  } else {
    char t[12];
    fmtElapsed(millis() - occupancyStartMs, t, sizeof(t));
    freeStartMs = millis();
    Serial.printf("[SENS] hand removed             ->  FREE   (booking lasted %s)\n", t);
  }

  digitalWrite(LED_PIN, occupied ? HIGH : LOW);
  updateLcd();
  publishStatus();
}

void mqttCallback(char *topic, byte *payload, unsigned int len) {
  char msg[16] = {0};
  if (len >= sizeof(msg)) len = sizeof(msg) - 1;
  memcpy(msg, payload, len);

  if (strcmp(topic, topicCmd) == 0 && strcmp(msg, "ping") == 0) {
    Serial.println("[MQTT] ping received -> republishing status");
    publishStatus();
  }
}

/* ------------------------------------------------------------------ */
void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.printf("[WiFi] connecting to \"%s\"", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(300);
    Serial.print('.');
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[WiFi] connected, IP %s\n", WiFi.localIP().toString().c_str());
#if ENABLE_LCD
    lcd.setCursor(0, 0);
    lcd.print("WiFi connected  ");
#endif
  } else {
    Serial.println("[WiFi] not connected yet — retrying in background");
  }
}

void connectMqtt() {
  if (!WiFi.isConnected() || mqtt.connected()) return;
  Serial.printf("[MQTT] connecting to %s:%u as %s …\n", MQTT_HOST, MQTT_PORT, clientId);
  // Last-Will: if the node dies/crashes, the broker marks it "offline" for everyone
  if (mqtt.connect(clientId, nullptr, nullptr, topicAvail, 1, true, "offline")) {
    Serial.println("[MQTT] connected");
    mqtt.publish(topicAvail, "online", true);
    publishStatus();                       // announce current state immediately
    mqtt.subscribe(topicCmd);
  } else {
    Serial.printf("[MQTT] failed, rc=%d — retrying\n", mqtt.state());
  }
}

/* ------------------------------------------------------------------ */
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n=== Smart Parking IR node ===");
  Serial.printf("Slot id: %s | prefix: %s\n", SLOT_ID, MQTT_PREFIX);

  pinMode(IR_SENSOR_PIN, INPUT);
  pinMode(LED_PIN, OUTPUT);
#if ENABLE_BUZZER
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
#endif
  digitalWrite(LED_PIN, LOW);

#if ENABLE_LCD
  Wire.begin();                            // ESP32 default SDA=21 SCL=22
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("Smart Parking");
  lcd.setCursor(0, 1);
  lcd.print("Starting…");
#endif

  buildTopics();
  delay(1200);                                  // let the IR module power up
  lastRaw = irDetected();                       // adopt current reading at boot
  occupied = lastRaw;
  rawChangeMs = millis();
  freeStartMs = millis();
  digitalWrite(LED_PIN, occupied ? HIGH : LOW);

  connectWifi();
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(mqttCallback);
  mqtt.setKeepAlive(15);
  connectMqtt();
}

void loop() {
  mqtt.loop();

  unsigned long now = millis();

  // --- reconnects (non-blocking, throttled) ---
  if (WiFi.status() != WL_CONNECTED && now - lastWifiTryMs > 5000) {
    lastWifiTryMs = now;
    connectWifi();
  }
  if (!mqtt.connected() && now - lastMqttTryMs > 3000) {
    lastMqttTryMs = now;
    connectMqtt();
  }

  // --- IR sensor debounce: reading must be stable for STABLE_MS ---
  bool raw = irDetected();
  if (raw != lastRaw) {
    lastRaw = raw;
    rawChangeMs = now;
  } else if (raw != occupied && now - rawChangeMs >= STABLE_MS) {
    onStateChange(raw);
  }

  // --- heartbeat: proves the node is alive, refreshes retained state ---
  if (mqtt.connected() && now - lastHeartbeatMs >= HEARTBEAT_MS) {
    lastHeartbeatMs = now;
    publishStatus();
  }

#if ENABLE_BUZZER
  digitalWrite(BUZZER_PIN, now < beepUntilMs ? HIGH : LOW);
#endif

  // --- LCD refresh 1 Hz (live booking timer) ---
#if ENABLE_LCD
  if (now - lastLcdMs >= 1000) {
    lastLcdMs = now;
    updateLcd();
  }
#endif
}
