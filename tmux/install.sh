#!/usr/bin/env bash

if [ -n "$BASH_VERSION" ]; then
	SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
elif [ -n "$ZSH_VERSION" ]; then
	SCRIPT_DIR="${0:A:h}"
else
	SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
fi

function install_tmux_conf() {
	if [ -f "$SCRIPT_DIR/.tmux.conf" ]; then
		if [ -f "$HOME/.tmux.conf" ]; then
			cp "$HOME/.tmux.conf" "$HOME/.tmux.conf.bak"
		fi
		cp "$SCRIPT_DIR/.tmux.conf" "$HOME/.tmux.conf"
	else
		echo "Warning: No .tmux.conf found in $SCRIPT_DIR"
	fi
}

function install_plugin() {
	local pack_dir="$1"
	local plugin="$2"
	local plugin_name
	plugin_name="$(basename "$plugin" .git)"

	mkdir -p "$pack_dir"

	if [ -d "$pack_dir/$plugin_name/.git" ]; then
		echo "Updating '$plugin_name'..."
		git -C "$pack_dir/$plugin_name" pull --ff-only
	elif [ -e "$pack_dir/$plugin_name" ]; then
		echo "Warning: '$pack_dir/$plugin_name' exists but is not a Git repository"
	else
		echo "Installing '$plugin_name'..."
		git clone "$plugin" "$pack_dir/$plugin_name"
	fi
}

function install_packs() {
	local PACK_DIR="$HOME/.tmux/plugins"

	local plugins=(
		"https://github.com/tmux-plugins/tpm.git"
	)

	for plugin in "${plugins[@]}"; do
		install_plugin "$PACK_DIR" "$plugin"
	done

	if tmux info >/dev/null 2>&1; then
		tmux source-file "$HOME/.tmux.conf"
	fi

	"$PACK_DIR/tpm/bin/install_plugins"

	echo ""
	echo "Tmux plugins installed under $PACK_DIR"
}

install_tmux_conf
install_packs
