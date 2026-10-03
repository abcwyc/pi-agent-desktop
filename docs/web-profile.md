# Web profile

`npm run web` starts the dev server on `127.0.0.1` and opens `http://127.0.0.1:<port>` in the desktop browser after Next prints `Ready`. The default port is `30141`.

From WSL, the helper opens the Windows default browser with `powershell.exe -NoProfile -Command Start-Process '<url>'`. On macOS it uses `open`. On other Linux hosts it uses `xdg-open`.

`npm run dev` starts the same loopback server and does not open a browser.

```bash
npm run web
npm run web -- --no-open
npm run web -- -p 8080
```

`--no-open` and `PI_WEB_NO_OPEN=1` print the URL and skip the browser. A non-empty `SSH_CONNECTION` or `SSH_TTY` does the same. The server stays up if the browser cannot be opened; the warning repeats the URL.

Production `pi-web` uses the same handoff. The printed URL is always `http://127.0.0.1:<port>`.

The npm package ships `lib/browser-open.js` and no other file from `lib/`.
