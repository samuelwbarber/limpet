-- winux WezTerm configuration.
-- WezTerm is the host "app": it provides GPU rendering, persistent/auto-
-- reconnecting sessions (its own multiplexer), and launches PowerShell with
-- the Winux module preloaded so Linux commands work everywhere.

local wezterm = require 'wezterm'
local config = wezterm.config_builder and wezterm.config_builder() or {}

-- Locate winux. The installer sets WINUX_HOME; fall back to the default.
local home = os.getenv('WINUX_HOME') or (os.getenv('USERPROFILE') .. '\\winux')
local module = home .. '\\shell\\Winux.psd1'

-- Prefer PowerShell 7 (pwsh) if installed, otherwise Windows PowerShell.
local function on_path(exe)
  local f = io.popen('where ' .. exe .. ' 2>NUL')
  if not f then return false end
  local out = f:read('*l'); f:close()
  return out ~= nil and out ~= ''
end
local shell = on_path('pwsh.exe') and 'pwsh.exe' or 'powershell.exe'

config.default_prog = { shell, '-NoExit', '-Command', 'Import-Module "' .. module .. '"' }

-- ---- Rendering (this is what fixes "TUI in PowerShell sucks") -------------
config.front_end = 'WebGpu'        -- GPU-accelerated; smooth redraw, no flicker
config.font = wezterm.font_with_fallback({ 'Cascadia Mono', 'Consolas' })
config.font_size = 11.0
config.color_scheme = 'Catppuccin Mocha'
config.scrollback_lines = 10000
config.audible_bell = 'Disabled'
config.window_close_confirmation = 'NeverPrompt'

-- ---- Resilient SSH --------------------------------------------------------
-- WezTerm's own multiplexer keeps the session alive on the remote and
-- transparently reconnects after a dropped link. Pair with key-based auth
-- (ssh-agent) so reconnects never prompt for a password. Edit to taste.
config.ssh_domains = {
  {
    name = 'example-server',
    remote_address = 'your.server.com',
    username = 'youruser',
    multiplexing = 'WezTerm',
  },
}

-- Launcher entries (the (v) arrow next to the + tab). Use one resilient method
-- per host, not several stacked together.
config.launch_menu = {
  { label = 'PowerShell', args = { shell } },
  -- Client-side resilient SSH: auto-reconnects (no password) and reattaches
  -- to a remote tmux session. Needs only your SSH key + tmux on the server.
  { label = 'SSH (auto-reconnect): example-server',
    args = { shell, '-NoExit', '-File', home .. '\\ssh-resilient.ps1',
             '-Target', 'youruser@your.server.com' } },
  -- mosh alternative (requires mosh-server on the remote):
  { label = 'mosh: example-server', args = { 'mosh', 'youruser@your.server.com' } },
}

-- ---- Keybindings: tmux-style splits with Ctrl+a as the leader ------------
config.leader = { key = 'a', mods = 'CTRL', timeout_milliseconds = 1000 }
config.keys = {
  { key = '|', mods = 'LEADER|SHIFT', action = wezterm.action.SplitHorizontal { domain = 'CurrentPaneDomain' } },
  { key = '-', mods = 'LEADER',       action = wezterm.action.SplitVertical   { domain = 'CurrentPaneDomain' } },
  { key = 'c', mods = 'LEADER',       action = wezterm.action.SpawnTab 'CurrentPaneDomain' },
  { key = 'h', mods = 'LEADER',       action = wezterm.action.ActivatePaneDirection 'Left' },
  { key = 'l', mods = 'LEADER',       action = wezterm.action.ActivatePaneDirection 'Right' },
  { key = 'k', mods = 'LEADER',       action = wezterm.action.ActivatePaneDirection 'Up' },
  { key = 'j', mods = 'LEADER',       action = wezterm.action.ActivatePaneDirection 'Down' },
}

return config
