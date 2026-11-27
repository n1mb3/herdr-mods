#!/usr/bin/env python3
"""Abre o popup de conversas. Script, e não "herdr plugin pane open" direto no
manifest, porque a ação roda com o PATH do plugin: o binário vem de
HERDR_BIN_PATH."""
import os
import shutil
import subprocess
import sys

herdr = os.environ.get("HERDR_BIN_PATH") or shutil.which("herdr")
if not herdr:
    sys.exit("herdr não encontrado (defina HERDR_BIN_PATH)")
# No Windows o painel roda "python", e não "python3": é outro item do manifest.
painel = "lista-windows" if os.name == "nt" else "lista"
sys.exit(subprocess.run(
    [herdr, "plugin", "pane", "open", "--plugin", "herdr-conversas", "--entrypoint", painel],
    creationflags=0x08000000 if os.name == "nt" else 0).returncode)
