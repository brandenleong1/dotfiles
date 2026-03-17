# Tmux

Place `.tmux.conf` in the home directory (`~/.tmux.conf`)

Run it with Tmux by running `Ctrl-b` then `:source-file ~/.tmux.conf`, or from the command line with `tmux source-file ~/.tmux.conf`

If `set -g mouse on` doesn't work, then replace with

```
setw -g mode-mouse on
set -g mouse-select-pane on
set -g mouse-resize-pane on
set -g mouse-select-window on
```
