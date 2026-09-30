/*
 * =====================================================================
 *  Smart Parking System — ARDUINO UNO + HW-201 IR sensor (USB mode)
 * =====================================================================
 *  The Uno has no network connection, so it streams JSON status lines
 *  over its USB cable to the PC, where serial-bridge.js republishes
 *  them to the central MQTT broker — identical payload format and
 *  topics as the ESP32 node, so the dashboard works unchanged.
 *
 *    Serial (9600 baud): {"slot":"S1","occupied":true,"deviceTimeMs":12345,"seq":7}
 *
 *  WIRING (HW-201 module):
 *    OUT -> D2      VCC -> 5V      GND -> GND
 *    (Uno is 5 V-tolerant, so the module can run from 5 V for best range)
 *  Optional:
 *    Buzzer (+) -> D8        16x2 I2C LCD -> A4(SDA)/A5(SCL)
 *    Onboard LED (D13) lights while the slot is BOOKED.
 *
 *  Libs: LiquidCrystal_I2C by Frank de Brabander (only if ENABLE_LCD 1)
 *
 *  NOTE: while this sketch runs, keep the Arduino Serial Monitor CLOSED
 *  and run:  node serial-bridge.js        (on the PC, same folder as server)
 * =====================================================================
 */

// ======================= CONFIG (edit here) =========================
const char *SLOT_ID = "S1";      // unique per Uno: S1, S2, ...

#define IR_SENSOR_PIN  2         // HW-201 OUT
#define IR_ACTIVE_LOW  1         // HW-201 output goes LOW when a hand is detected

#define LED_PIN        13        // onboard LED: ON while slot is BOOKED

#define ENABLE_BUZZER  0         // set 1 after wiring an active buzzer to D8
#define BUZZER_PIN     8

#define ENABLE_LCD     0         // set 1 after wiring a 16x2 I2C LCD (A4/A5)
#define LCD_ADDR       0x27      // typical: 0x27 or 0x3F

#define STABLE_MS      300       // debounce: reading must hold this long
#define HEARTBEAT_MS   30000UL   // re-send status every 30 s
// ====================================================================

#if ENABLE_LCD
  #include <Wire.h>
  #include <LiquidCrystal_I2C.h>
  LiquidCrystal_I2C lcd(LCD_ADDR, 16, 2);
#endif

bool          occupied = false;
bool          lastRaw  = false;
unsigned long rawChangeMs = 0;
unsigned long occupancyStartMs = 0;
unsigned long lastHeartbeatMs = 0;
unsigned long beepUntilMs = 0;
unsigned long seq = 0;

bool irDetected() {
  return digitalRead(IR_SENSOR_PIN) == (IR_ACTIVE_LOW ? LOW : HIGH);
}

/* Same JSON shape the ESP32 sketch and simulator publish. */
void sendStatus() {
  seq++;
  Serial.print(F("{\"slot\":\""));
  Serial.print(SLOT_ID);
  Serial.print(F("\",\"occupied\":"));
  Serial.print(occupied ? F("true") : F("false"));
  Serial.print(F(",\"deviceTimeMs\":"));
  Serial.print(millis());
  Serial.print(F(",\"seq\":"));
  Serial.print(seq);
  Serial.println(F("}"));
}

void updateLcd() {
#if ENABLE_LCD
  char line[17];
  snprintf(line, sizeof(line), "S%s %s", SLOT_ID, occupied ? "BOOKED" : "FREE");
  lcd.setCursor(0, 0);
  lcd.print(line);
  lcd.print(F("   "));

  unsigned long s = (occupied ? millis() - occupancyStartMs : 0) / 1000;
  char t[9];
  snprintf(t, sizeof(t), "%02lu:%02lu:%02lu", s / 3600, (s / 60) % 60, s % 60);
  lcd.setCursor(0, 1);
  lcd.print(occupied ? "Time " : "Free ");
  lcd.print(t);
  lcd.print(F("     "));
#endif
}

void onStateChange(bool nowOccupied) {
  occupied = nowOccupied;
  if (occupied) {
    occupancyStartMs = millis();
#if ENABLE_BUZZER
    beepUntilMs = millis() + 150;
#endif
    Serial.println(F("// hand placed on sensor -> BOOKED"));
  } else {
    Serial.println(F("// hand removed -> FREE"));
  }
  digitalWrite(LED_PIN, occupied ? HIGH : LOW);
  updateLcd();
  sendStatus();
}

void setup() {
  Serial.begin(9600);
  pinMode(IR_SENSOR_PIN, INPUT);
  pinMode(LED_PIN, OUTPUT);
#if ENABLE_BUZZER
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
#endif
  digitalWrite(LED_PIN, LOW);

#if ENABLE_LCD
  Wire.begin();
  lcd.init();
  lcd.backlight();
  lcd.print("Smart Parking");
  lcd.setCursor(0, 1);
  lcd.print("Starting...");
#endif

  delay(1200);                       // let the IR module power up and settle
  lastRaw = irDetected();            // adopt the current reading at boot
  occupied = lastRaw;
  rawChangeMs = millis();
  digitalWrite(LED_PIN, occupied ? HIGH : LOW);
  updateLcd();
  sendStatus();                      // announce initial state to the bridge
  lastHeartbeatMs = millis();
}

void loop() {
  unsigned long now = millis();

  /* debounce: raw reading must be stable for STABLE_MS to count */
  bool raw = irDetected();
  if (raw != lastRaw) {
    lastRaw = raw;
    rawChangeMs = now;
  } else if (raw != occupied && now - rawChangeMs >= STABLE_MS) {
    onStateChange(raw);
  }

  /* heartbeat proves the node is alive */
  if (now - lastHeartbeatMs >= HEARTBEAT_MS) {
    lastHeartbeatMs = now;
    sendStatus();
  }

#if ENABLE_BUZZER
  digitalWrite(BUZZER_PIN, now < beepUntilMs ? HIGH : LOW);
#endif

#if ENABLE_LCD
  static unsigned long lastLcdMs = 0;
  if (now - lastLcdMs >= 1000) {
    lastLcdMs = now;
    updateLcd();
  }
#endif
}
