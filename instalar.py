#!/usr/bin/env python3
"""Instala os mods no herdr-app e o plugin no herdr de terminal.

- Copia mods/ e layouts/ para a pasta do app (~/.config/herdr-app, ou
  $HERDR_APP_HOME) e o tui/conversas.py para mods/conversas/, que é quem
  lista as conversas para o mod.
- Liga o plugin tui/ no herdr de terminal (herdr plugin link), se ele existir.

Rode de novo depois de cada git pull. Não mexe no keys nem no config.toml.
"""
import os
import shutil
import subprocess
import sys

RAIZ = os.path.dirname(os.path.abspath(__file__))
APP = os.environ.get("HERDR_APP_HOME") or os.path.join(os.path.expanduser("~"), ".config", "herdr-app")


def copiar_pasta(origem: str, destino: str) -> None:
    for nome in os.listdir(origem):
        o, d = os.path.join(origem, nome), os.path.join(destino, nome)
        if os.path.isdir(o):
            # copia por cima, sem apagar o que o app escreve na pasta (gpui-kit.d.ts, jsconfig.json)
            shutil.copytree(o, d, dirs_exist_ok=True)
        else:
            os.makedirs(destino, exist_ok=True)
            shutil.copy2(o, d)


def main() -> int:
    if not os.path.isdir(APP):
        print(f"{APP} não existe: abra o herdr-app uma vez antes de instalar.")
        return 1
    copiar_pasta(os.path.join(RAIZ, "mods"), os.path.join(APP, "mods"))
    copiar_pasta(os.path.join(RAIZ, "layouts"), os.path.join(APP, "layouts"))
    shutil.copy2(os.path.join(RAIZ, "tui", "conversas.py"), os.path.join(APP, "mods", "conversas", "conversas.py"))
    print(f"mods e layout copiados para {APP}")

    herdr = shutil.which("herdr")
    if not herdr:
        print("herdr de terminal não encontrado: plugin do popup não ligado.")
        return 0
    tui = os.path.join(RAIZ, "tui")
    lista = subprocess.run([herdr, "plugin", "list"], capture_output=True, text=True).stdout
    if "herdr-conversas" in lista:
        subprocess.run([herdr, "plugin", "unlink", "herdr-conversas"], capture_output=True)
    r = subprocess.run([herdr, "plugin", "link", tui], capture_output=True, text=True)
    print("plugin herdr-conversas ligado" if r.returncode == 0 else f"herdr plugin link falhou: {r.stderr.strip()}")
    return r.returncode


if __name__ == "__main__":
    sys.exit(main())
