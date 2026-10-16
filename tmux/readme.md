# Tmux

Run `install.sh` for automatic installation. For manual installation, follow the instructions below.

Place `.tmux.conf` in the home directory (`~/.tmux.conf`)

Run it with Tmux by running `Ctrl-b` then `:source-file ~/.tmux.conf`, or from the command line with `tmux source-file ~/.tmux.conf`

If `set -g mouse on` doesn't work, then replace with

```
setw -g mode-mouse on
set -g mouse-select-pane on
set -g mouse-resize-pane on
set -g mouse-select-window on
```

Clone TPM to `~/.tmux/plugins`, then run `~/.tmux/plugins/tpm/bin/install_plugins` or `Ctrl+B I` (in Tmux) to install the rest of the packages.

### Packs

* Tmux Plugin Manager - [tmux-plugins/tpm](https://github.com/tmux-plugins/tpm)
* tmux-resurrect - [tmux-plugins/tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect)
* tmux-continuum - [tmux-plugins/tmux-continuum](https://github.com/tmux-plugins/tmux-continuum)
