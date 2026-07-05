# Demo recording rig

Scripts used to produce the GIFs in `docs/media/`. They drive the real winux
app with Playwright and screen-record it with ffmpeg.

```powershell
cd tools\demo
npm init -y
npm install playwright-core ffmpeg-static

node record.js shell     # winux banner + Linux commands
node record.js peek      # inline image at the local prompt
node record.js xssh      # ssh drop + auto-reconnect
node record.js remote    # peek + download inside an ssh session
node record.js drop      # drag & drop upload into the session
.\togif.ps1              # mp4 -> palette-optimized GIFs (gifs\*.gif)
```

Prerequisites the scripts assume:

- **WSL with sshd** for the ssh scenarios: `apt install openssh-server`, your
  Windows `~/.ssh/id_ed25519.pub` in WSL `~/.ssh/authorized_keys`. record.js
  starts the service and holds the WSL VM alive itself.
- **Staged files**: `gpu_util.png` in the Windows home dir (peek scenario) and
  in the WSL home dir (remote scenario); a `report.pdf` next to record.js
  (drop scenario). Any small png/pdf works.
- Capture is a desktop-region grab of the window's coordinates (gdigrab
  window-capture of a GPU-composited Electron window records white), so keep
  the window unobscured while recording.
