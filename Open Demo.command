#!/bin/zsh

cd -- "$(dirname -- "$0")" || exit 1

if ! command -v node >/dev/null 2>&1 && [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  source "$HOME/.nvm/nvm.sh"
fi
if ! command -v node >/dev/null 2>&1; then
  print "Node.js 22+ is needed. Open the project in your configured development terminal and run npm run demo."
  read -k 1 "?Press any key to close."
  exit 1
fi

print "Opening Support Lab. Keep this window open while you use the demo."
print "This is rules rehearsal: no paid API calls and no customer email sending."
print "Press Control + C here when you are finished."
export DEMO_DATA_DIR="$PWD/runtime/live-evaluation"
node server/index.mjs --rehearsal --auto-port --open-browser
demo_status=$?
if (( demo_status != 0 )); then
  print "The demo did not start. Share the error above without sharing any API key."
  read -k 1 "?Press any key to close."
fi
exit $demo_status
