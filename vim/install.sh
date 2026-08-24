#!/bin/bash

function install_vimrc() {
	local SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

	if [ -f "$SCRIPT_DIR/.vimrc" ]; then
		if [ -f "$HOME/.vimrc" ]; then
			cp "$HOME/.vimrc" "$HOME/.vimrc.bak"
		fi
		cp "$SCRIPT_DIR/.vimrc" "$HOME/.vimrc"
	else
		echo "Warning: No .vimrc found in $SCRIPT_DIR"
	fi
}

function install_packs() {
	local PACK_DIR="$HOME/.vim/pack/vendor/start"

	mkdir -p "$PACK_DIR"

	plugins=(
		"https://github.com/preservim/nerdtree.git"
		"https://github.com/airblade/vim-gitgutter.git"
		"https://github.com/sheerun/vim-polyglot.git"
		"https://github.com/vim-airline/vim-airline.git"
		"https://github.com/vim-airline/vim-airline-themes.git"
		"https://github.com/tpope/vim-fugitive.git"
		"https://github.com/ludovicchabant/vim-gutentags.git"
		"https://github.com/Thyrum/vim-stabs.git"
	)

	for plugin in "${plugins[@]}"; do
		local plugin_name=$(basename "$plugin" .git)
		
		if [ -d "$PACK_DIR/$plugin_name" ]; then
			echo "Updating '$plugin_name'..."
			git -C "$PACK_DIR/$plugin_name" pull
		else
			echo "Installing '$plugin_name'..."
			git clone "$plugin" "$PACK_DIR/$plugin_name"
		fi
	done

	echo ""
	echo "Vim plugins installed to $PACK_DIR"
}

function install_after() {
	local SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
	local AFTER_DIR="$HOME/.vim/after"

	if [ -d "$SCRIPT_DIR/after" ]; then
		mkdir -p "$AFTER_DIR"
		cp -r "$SCRIPT_DIR/after/." "$AFTER_DIR/"
		echo ""
		echo "Vim after/ files installed to $AFTER_DIR"
	else
		echo "Warning: No after/ directory found in $SCRIPT_DIR"
	fi
}

install_vimrc
install_packs
install_after
