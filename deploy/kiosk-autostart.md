# Starting the terminal in kiosk mode

## Raspberry Pi / Linux (Chromium)

Create `~/.config/autostart/timeclock.desktop`:

```ini
[Desktop Entry]
Type=Application
Name=Reloj NFC
Exec=chromium-browser --kiosk --noerrdialogs --disable-infobars --incognito "http://localhost:3000/?device=entrada-1"
X-GNOME-Autostart-enabled=true
```

Keep the screen awake:

```bash
sudo apt install -y unclutter
echo -e "xset s off\nxset -dpms\nxset s noblank\nunclutter -idle 0 &" >> ~/.xsessionrc
```

## Windows

Create a shortcut in `shell:startup` pointing at:

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --edge-kiosk-type=fullscreen "http://localhost:3000/?device=entrada-1"
```

## Android tablet or phone

Open `http://<server-ip>:3000/` in Chrome and choose *Add to home screen*.
On Android the page can also read tags with the built-in NFC radio (Web NFC),
which needs HTTPS or `localhost`; over plain HTTP on the LAN the USB reader
path still works.

## Terminal settings

Both are remembered in the browser's local storage after the first visit:

- `?device=entrada-1` — the name recorded on every punch from this terminal.
- `?key=<KIOSK_KEY>` — required only when `KIOSK_KEY` is set in `.env`.
