#!/bin/bash

if [ -n "$BASH_VERSION" ]; then
	SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
elif [ -n "$ZSH_VERSION" ]; then
	SCRIPT_DIR="${0:A:h}"
else
	SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
fi

function install_vimrc() {
	if [ -f "$SCRIPT_DIR/.vimrc" ]; then
		if [ -f "$HOME/.vimrc" ]; then
			cp "$HOME/.vimrc" "$HOME/.vimrc.bak"
		fi
		cp "$SCRIPT_DIR/.vimrc" "$HOME/.vimrc"
	else
		echo "Warning: No .vimrc found in $SCRIPT_DIR"
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
	local START_DIR="$HOME/.vim/pack/vendor/start"
	local OPT_DIR="$HOME/.vim/pack/vendor/opt"

	local plugins=(
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
		install_plugin "$START_DIR" "$plugin"
	done

	local opt_plugins=(
		"https://github.com/yegappan/lsp.git"
	)

	for plugin in "${opt_plugins[@]}"; do
		install_plugin "$OPT_DIR" "$plugin"
	done

	echo ""
	echo "Vim plugins installed under $HOME/.vim/pack/vendor"
}

function color_text() {
	local text="$1"
	local color_code="$2"

	local UNSET="\e[0m"

	echo -ne "${color_code}${text}${UNSET}"
}

function check_lsp_dependencies() {
	local SUCCESS_COLOR="\e[0;32m"
	local FAILURE_COLOR="\e[0;31m"

	echo ""
	echo "LSP server status:"

	if command -v clangd >/dev/null 2>&1; then
		echo -e "  C/C++:  clangd $(color_text 'found' $SUCCESS_COLOR)"
	else
		echo -e "  C/C++:  clangd $(color_text 'missing' $FAILURE_COLOR) (Ubuntu: sudo apt install clangd)"
	fi

	if command -v pyright-langserver >/dev/null 2>&1 || [ -x "$HOME/.local/bin/pyright-langserver" ]; then
		echo -e "  Python: pyright-langserver $(color_text 'found' $SUCCESS_COLOR)"
	else
		echo -e "  Python: pyright-langserver $(color_text 'missing' $FAILURE_COLOR) (npm install --global --prefix ~/.local pyright)"
	fi

	if command -v lake >/dev/null 2>&1 || [ -x "$HOME/.elan/bin/lake" ]; then
		echo -e "  Lean:   lake $(color_text 'found' $SUCCESS_COLOR)"
	else
		echo -e "  Lean:   lake $(color_text 'missing' $FAILURE_COLOR) (install Lean using elan)"
	fi

	if command -v ctags >/dev/null 2>&1; then
		echo -e "  Tags:   ctags $(color_text 'found' $SUCCESS_COLOR)"
	else
		echo -e "  Tags:   ctags $(color_text 'missing' $FAILURE_COLOR); vim-gutentags will remain disabled"
	fi
}

function install_after() {
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
check_lsp_dependencies
