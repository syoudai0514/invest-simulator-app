@echo off
REM Local trade cycle runner (called every 5 min by Windows Task Scheduler).
REM Replaces the unreliable GitHub Actions schedule. Uses the same rule engine
REM (lib/rule-trade) for US and JP. Output is appended to data/local-trade.log.
cd /d "C:\dev\invest-simulator-app"
set "PATH=C:\Program Files\nodejs;%PATH%"
echo ---------- %DATE% %TIME% ---------->> "data\local-trade.log"
call npx tsx --env-file=.env.local scripts\trade.ts >> "data\local-trade.log" 2>&1
