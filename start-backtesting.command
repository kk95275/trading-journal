#!/bin/zsh
# Starts the trading journal and opens it in your browser.
cd "$(dirname "$0")"
( sleep 2 && open "http://localhost:5173" ) &
npm run dev
