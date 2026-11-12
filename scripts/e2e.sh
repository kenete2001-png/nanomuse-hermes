#!/usr/bin/env bash
# Install the release APK on an emulator, launch it and wait for the on-device
# Hermes to come up. Screenshots, UI dump and logcat go to ./e2e.
set -u
PKG=io.github.kenete.hermes
mkdir -p e2e
APK=$(ls dist/*.apk | head -1)
{
  echo "abi: $(adb shell getprop ro.product.cpu.abilist)"
  echo "native bridge: $(adb shell getprop ro.dalvik.vm.native.bridge) exec=$(adb shell getprop ro.enable.native.bridge.exec)"
  echo "sdk: $(adb shell getprop ro.build.version.sdk)"
} | tee e2e/summary.txt
adb shell settings put global package_verifier_enable 0 >/dev/null 2>&1
echo "install: $(adb install -r -g "$APK" 2>&1 | tail -1)" | tee -a e2e/summary.txt
adb logcat -c
adb shell am start -W -n "$PKG/io.github.hermesandroid.MainActivity" | tail -2
ok=0
start=$(date +%s)
for i in $(seq 1 150); do
  sleep 10
  adb forward tcp:9119 tcp:9119 >/dev/null 2>&1
  if curl -sf -m 5 http://127.0.0.1:9119/api/status > e2e/status.json; then ok=1; break; fi
  if [ $((i % 9)) -eq 0 ]; then adb exec-out screencap -p > "e2e/wait-$i.png"; fi
  if ! adb shell pidof "$PKG" >/dev/null; then echo "app process died" | tee -a e2e/summary.txt; break; fi
done
echo "server up: $ok after $(( $(date +%s) - start ))s" | tee -a e2e/summary.txt
head -c 300 e2e/status.json 2>/dev/null >> e2e/summary.txt; echo >> e2e/summary.txt
sleep 25
adb exec-out screencap -p > e2e/1-chat.png
adb logcat -d -v brief HermesWeb:V '*:S' > e2e/web-console.txt
if grep -q HERMES_GATEWAY_CONNECTED e2e/web-console.txt; then connected=1; else connected=0; fi
echo "chat UI connected to gateway: $connected" | tee -a e2e/summary.txt
grep -o "HERMES_SETUP_STATUS.*" e2e/web-console.txt | head -1 >> e2e/summary.txt

# Tap through the bottom tabs (positions as fractions of the screen size).
size=$(adb shell wm size | grep -o '[0-9]*x[0-9]*' | tail -1)
W=${size%x*}; H=${size#*x}
tap() { adb shell input tap "$1" "$2"; }
# Onglets : Chat, Agent, Tableau, Système (4 onglets, centres à 1/8, 3/8, 5/8, 7/8).
tapText() {  # touche l'élément dont le texte vaut $1 (via uiautomator)
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  adb shell cat /sdcard/ui.xml > e2e/ui.xml 2>/dev/null
  b=$(python3 scripts/find_text.py e2e/ui.xml "$1")
  if [ -n "$b" ]; then tap $b; echo "tap '$1' at $b" >> e2e/summary.txt; else echo "not found: $1" >> e2e/summary.txt; fi
}
tap $((W * 3 / 8)) $((H * 955 / 1000)); sleep 4; adb exec-out screencap -p > e2e/2-agent.png
adb shell input swipe $((W / 2)) $((H * 7 / 10)) $((W / 2)) $((H * 2 / 10)) 300; sleep 2; adb exec-out screencap -p > e2e/2b-agent-bas.png
tapText "Mémoire"; sleep 3; adb exec-out screencap -p > e2e/2c-memoire.png
adb shell input keyevent 4; sleep 2
adb shell input swipe $((W / 2)) $((H * 3 / 10)) $((W / 2)) $((H * 8 / 10)) 300; sleep 2
tapText "Modèle"; sleep 20; adb exec-out screencap -p > e2e/3-modele.png
tap $((W * 5 / 8)) $((H * 955 / 1000)); sleep 8; adb exec-out screencap -p > e2e/4-tableau.png
tap $((W * 7 / 8)) $((H * 955 / 1000)); sleep 6; adb exec-out screencap -p > e2e/5-systeme.png
tap $((W / 8)) $((H * 955 / 1000)); sleep 3; adb exec-out screencap -p > e2e/6-chat.png

adb logcat -d -v brief Hermes:V HermesWeb:V AndroidRuntime:E '*:S' > e2e/logcat.txt
grep -i "out of sync\|Traceback\|Error" e2e/logcat.txt | head -20 >> e2e/summary.txt
[ "$ok" = 1 ] && [ "$connected" = 1 ]
