/*
 * =====================================================================
 *  Smart Parking System — ARDUINO UNO, MULTIPLE IR sensors (USB mode)
 * =====================================================================
 *  One Uno watches several HW-201 IR modules (one per parking slot) and
 *  streams a JSON status line over USB for whichever slot changes:
 *
 *    {"slot":"S1","occupied":true,"deviceTimeMs":12345,"seq":7}
 *    {"slot":"S3","occupied":false,"deviceTimeMs":12345,"seq":12}
 *
 *  serial-bridge.js on the PC turns these into the same MQTT messages as
 *  the ESP32 nodes — the dashboard picks every slot up automatically.
 *
 *  WIRING (per HW-201 module):
 *    OUT -> its pin below      VCC -> 5V rail      GND -> GND rail
 *    (all modules share the same 5V and GND — use breadboard power rails)
 *  Optional: buzzer + -> D8 (beeps on booking), 16x2 I2C LCD -> A4/A5.
 *  The onboard LED (D13) flashes on every sensor event as a heartbeat.
 *
 *  NOTE: keep the Arduino Serial Monitor CLOSED while serial-bridge.js runs.
 * =====================================================================
 */

// ======================= CONFIG (edit here) =========================
struct Sensor {
  const char *id;
  uint8_t     pin;
};

// one line per parking slot — add or remove freely (D2..D12 usable,
// avoid D0/D1 = USB serial and D13 = onboard LED)
Sensor SENSORS[] = {
  { "S1", 2 },
  { "S2", 3 },
  { "S3", 4 },
  { "S4", 5 },
  { "S5", 6 },
  { "S6", 7 },
};

#define IR_ACTIVE_LOW  1         // HW-201 output goes LOW when a hand is detected

#define ENABLE_BUZZER  0         // set 1 after wiring an active buzzer to D8
#define BUZZER_PIN     8

#define ENABLE_LCD     0         // set 1 after wiring a 16x2 I2C LCD (A4/A5)
#define LCD_ADDR       0x27      // typical: 0x27 or 0x3F

#define STABLE_MS      300       // debounce: reading must hold this long
#define HEARTBEAT_MS   30000UL   // re-send all statuses every 30 s
// ====================================================================

#if ENABLE_LCD
  #include <Wire.h>
  #include <LiquidCrystal_I2C.h>
  LiquidCrystal_I2C lcd(LCD_ADDR, 16, 2);
#endif

const uint8_t NUM = sizeof(SENSORS) / sizeof(SENSORS[0]);

bool          occupied[NUM];
bool          lastRaw[NUM];
unsigned long rawChangeMs[NUM];
unsigned long occupancyStartMs[NUM];
unsigned long lastHeartbeatMs = 0;
unsigned long beepUntilMs     = 0;
unsigned long flashLedUntil   = 0;
unsigned long seq[NUM];

bool irDetected(uint8_t i) {
  return digitalRead(SENSORS[i].pin) == (IR_ACTIVE_LOW ? LOW : HIGH);
}

/* Same JSON shape the ESP32 sketch and simulator publish. */
void sendStatus(uint8_t i) {
  seq[i]++;
  Serial.print(F("{\"slot\":\""));
  Serial.print(SENSORS[i].id);
  Serial.print(F("\",\"occupied\":"));
  Serial.print(occupied[i] ? F("true") : F("false"));
  Serial.print(F(",\"deviceTimeMs\":"));
  Serial.print(millis());
  Serial.print(F(",\"seq\":"));
  Serial.print(seq[i]);
  Serial.println(F("}"));
}

void updateLcd() {
#if ENABLE_LCD
  uint8_t busy = 0;
  for (uint8_t i = 0; i < NUM; i++) busy += occupied[i] ? 1 : 0;
  lcd.setCursor(0, 0);
  lcd.print(F("Parking  "));
  lcd.print(busy);
  lcd.print('/');
  lcd.print(NUM);
  lcd.print(F(" busy "));
  unsigned long s = millis() / 1000;
  char t[9];
  snprintf(t, sizeof(t), "%02lu:%02lu", (s / 60) % 60, s % 60);
  lcd.setCursor(0, 1);
  lcd.print(F("up "));
  lcd.print(t);
  lcd.print(F("          "));
#endif
}

void onStateChange(uint8_t i, bool nowOccupied) {
  occupied[i] = nowOccupied;

  if (nowOccupied) {
    occupancyStartMs[i] = millis();
#if ENABLE_BUZZER
    beepUntilMs = millis() + 150;
#endif
    Serial.print(F("// "));
    Serial.print(SENSORS[i].id);
    Serial.println(F(" hand placed -> BOOKED"));
  } else {
    Serial.print(F("// "));
    Serial.print(SENSORS[i].id);
    Serial.println(F(" hand removed -> FREE"));
  }

  flashLedUntil = millis() + 60;      // activity blip on the onboard LED
  updateLcd();
  sendStatus(i);
}

void setup() {
  Serial.begin(9600);

  for (uint8_t i = 0; i < NUM; i++) {
    pinMode(SENSORS[i].pin, INPUT);
    occupied[i] = false;
    lastRaw[i]  = false;
    seq[i]      = 0;
  }
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, LOW);
#if ENABLE_BUZZER
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
#endif

#if ENABLE_LCD
  Wire.begin();
  lcd.init();
  lcd.backlight();
  lcd.print(F("Smart Parking"));
#endif

  delay(1200);                       // let the IR modules power up and settle

  for (uint8_t i = 0; i < NUM; i++) {
    lastRaw[i] = irDetected(i);      // adopt the current reading at boot
    occupied[i] = lastRaw[i];
    rawChangeMs[i] = millis();
    sendStatus(i);                   // announce initial state of every slot
  }
  lastHeartbeatMs = millis();
  updateLcd();
}

void loop() {
  unsigned long now = millis();

  for (uint8_t i = 0; i < NUM; i++) {
    /* debounce: raw reading must be stable for STABLE_MS to count */
    bool raw = irDetected(i);
    if (raw != lastRaw[i]) {
      lastRaw[i] = raw;
      rawChangeMs[i] = now;
    } else if (raw != occupied[i] && now - rawChangeMs[i] >= STABLE_MS) {
      onStateChange(i, raw);
    }
  }

  /* heartbeat: re-announce every slot, proves the node is alive */
  if (now - lastHeartbeatMs >= HEARTBEAT_MS) {
    lastHeartbeatMs = now;
    for (uint8_t i = 0; i < NUM; i++) sendStatus(i);
  }

#if ENABLE_BUZZER
  digitalWrite(BUZZER_PIN, now < beepUntilMs ? HIGH : LOW);
#endif

  digitalWrite(LED_BUILTIN, now < flashLedUntil ? HIGH : LOW);

#if ENABLE_LCD
  static unsigned long lastLcdMs = 0;
  if (now - lastLcdMs >= 1000) {
    lastLcdMs = now;
    updateLcd();
  }
#endif
}
