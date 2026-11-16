#!/usr/bin/env python3
"""Motor do mod Temas: lista, inspeciona, instala e remove layouts e temas do herdr-app.

Uso (sempre imprime um JSON):
  temas.py listar
  temas.py inspecionar <link>   herdr.dev/layouts/<dono>/<nome>, repositório do GitHub ou URL de um tema .json
  temas.py instalar <id>        o id que o inspecionar devolveu
  temas.py remover <nome>       só o que este motor instalou (ou adotou)
  temas.py adotar <nome> <origem> <arquivo>...   registra algo instalado à mão, para poder remover

Tudo o que é instalado fica anotado em <home do app>/.temas/registro.json, com a lista exata
de arquivos; remover apaga só essa lista. Layouts e temas do Herdr e os seus próprios
(main-conversas, clones) nunca entram no registro, então nunca são apagados por aqui.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request

APP = os.environ.get("HERDR_APP_HOME") or os.path.join(os.path.expanduser("~"), ".config", "herdr-app")
BASE = os.path.join(APP, ".temas")
CACHE = os.path.join(BASE, "cache")
REGISTRO = os.path.join(BASE, "registro.json")
SEM_JANELA = 0x08000000 if os.name == "nt" else 0
# O que vale avisar antes de instalar o código de outra pessoa (AGENTS.md do herdr-app).
RISCOS = {
    "roda programas": re.compile(r"\b(exec|hc)\s*\("),
    "acessa a rede": re.compile(r"\bfetch\s*\(|https?://(?!herdr\.dev)"),
    "lê arquivos fora da pasta": re.compile(r"\breadTextFile\s*\(|from\s+[\"']fs/promises[\"']"),
    "grava arquivos": re.compile(r"\bwriteTextFile\s*\(|\bwriteFile\s*\("),
}


def saida(obj) -> None:
    print(json.dumps(obj))  # ASCII com \uXXXX: o pipe do Windows é cp1252


def registro() -> dict:
    try:
        with open(REGISTRO, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def gravar_registro(reg: dict) -> None:
    os.makedirs(BASE, exist_ok=True)
    tmp = REGISTRO + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(reg, f, indent=1, ensure_ascii=False)
    os.replace(tmp, REGISTRO)


def nomes(pasta: str, ext: str) -> list:
    try:
        return sorted(os.path.splitext(n)[0] for n in os.listdir(pasta) if n.endswith(ext))
    except OSError:
        return []


def listar() -> dict:
    reg = registro()
    return {
        "layouts": nomes(os.path.join(APP, "layouts"), ".json"),
        "temas": nomes(os.path.join(APP, "themes"), ".json"),
        "instalados": {k: {"origem": v.get("origem"), "tipo": v.get("tipo"), "layout": v.get("layout"),
                           "temas": v.get("temas", [])} for k, v in reg.items()},
    }


# ---------------------------------------------------------------- inspecionar

def normalizar(link: str):
    """('repo', url_git, id) ou ('json', url, id)."""
    link = link.strip().rstrip("/")
    if not re.match(r"^https?://", link):
        link = "https://" + link
    m = re.match(r"^https?://(?:www\.)?herdr\.dev/(?:layouts|mods)/([^/]+)/([^/?#]+)", link)
    if m:
        return "repo", f"https://github.com/{m[1]}/{m[2]}.git", f"{m[1]}-{m[2]}"
    if link.lower().endswith(".json"):
        link = re.sub(r"^https://github\.com/([^/]+)/([^/]+)/blob/", r"https://raw.githubusercontent.com/\1/\2/", link)
        return "json", link, os.path.splitext(os.path.basename(link))[0]
    m = re.match(r"^https?://github\.com/([^/]+)/([^/?#]+?)(?:\.git)?$", link)
    if m:
        return "repo", f"https://github.com/{m[1]}/{m[2]}.git", f"{m[1]}-{m[2]}"
    raise ValueError("link não reconhecido: use herdr.dev/layouts/<dono>/<nome>, um repositório do GitHub ou um tema .json")


def tema_valido(d) -> bool:
    return isinstance(d, dict) and all(k in d for k in ("background", "foreground")) and isinstance(d.get("ansi"), list) and len(d["ansi"]) == 16


def pecas(raiz: str) -> dict:
    """Layouts, mods, temas e atalhos que um repositório traz, no formato de compartilhamento do Herdr."""
    out = {"layouts": nomes(os.path.join(raiz, "layouts"), ".json"), "mods": [], "temas": nomes(os.path.join(raiz, "themes"), ".json")}
    pm = os.path.join(raiz, "mods")
    if os.path.isdir(pm):
        out["mods"] = sorted(n for n in os.listdir(pm) if os.path.isfile(os.path.join(pm, n, "main.js")))
    elif os.path.isfile(os.path.join(raiz, "main.js")):
        out["mods"] = [os.path.basename(raiz).split("-", 1)[-1]]
        out["mod_na_raiz"] = True
    return out


def riscos(raiz: str, mods: list, na_raiz: bool) -> list:
    achados = set()
    for m in mods:
        pasta = raiz if na_raiz else os.path.join(raiz, "mods", m)
        for dirpath, _, arquivos in os.walk(pasta):
            for a in arquivos:
                if a.endswith(".js") and not a.endswith(".d.ts"):
                    try:
                        texto = open(os.path.join(dirpath, a), encoding="utf-8", errors="replace").read()
                    except OSError:
                        continue
                    achados.update(r for r, rx in RISCOS.items() if rx.search(texto))
    return sorted(achados)


def conflitos(p: dict, ident: str) -> list:
    reg = registro()
    meus = {f for k, v in reg.items() if k == ident for f in v.get("arquivos", [])}
    alvos = [f"layouts/{n}.json" for n in p["layouts"]] + [f"mods/{n}" for n in p["mods"]] + [f"themes/{n}.json" for n in p["temas"]]
    return [a for a in alvos if os.path.exists(os.path.join(APP, a)) and a not in meus]


def inspecionar(link: str) -> dict:
    tipo, url, ident = normalizar(link)
    destino = os.path.join(CACHE, ident)
    if os.path.isdir(destino):
        shutil.rmtree(destino, onerror=_forcar)
    os.makedirs(destino, exist_ok=True)
    if tipo == "json":
        with urllib.request.urlopen(url, timeout=30) as r:
            dados = json.loads(r.read().decode("utf-8"))
        if not tema_valido(dados):
            raise ValueError("o JSON não é um tema do herdr-app (precisa de background, foreground e 16 cores em ansi)")
        os.makedirs(os.path.join(destino, "themes"))
        with open(os.path.join(destino, "themes", ident + ".json"), "w", encoding="utf-8") as f:
            json.dump(dados, f, indent=1)
        p = {"layouts": [], "mods": [], "temas": [ident]}
    else:
        r = subprocess.run(["git", "clone", "--depth", "1", "-q", url, destino], capture_output=True, text=True,
                           timeout=300, creationflags=SEM_JANELA)
        if r.returncode != 0:
            raise RuntimeError(f"git clone falhou: {(r.stderr or r.stdout).strip()}")
        p = pecas(destino)
        if not (p["layouts"] or p["mods"] or p["temas"]):
            raise ValueError("o repositório não tem layouts/, mods/ nem themes/")
    with open(os.path.join(destino, ".origem"), "w", encoding="utf-8") as f:
        f.write(url)
    tamanho = sum(os.path.getsize(os.path.join(d, a)) for d, _, fs in os.walk(destino) if ".git" not in d for a in fs)
    return {"id": ident, "origem": url, **p, "riscos": riscos(destino, p["mods"], p.get("mod_na_raiz", False)),
            "conflitos": conflitos(p, ident), "mb": round(tamanho / 1048576, 1)}


# ---------------------------------------------------------------- instalar / remover

def _forcar(func, caminho, _info):
    os.chmod(caminho, 0o700)  # .git do Windows vem somente leitura
    func(caminho)


def apagar(rel: str) -> None:
    alvo = os.path.join(APP, rel)
    if os.path.isdir(alvo):
        shutil.rmtree(alvo, onerror=_forcar)
    elif os.path.exists(alvo):
        os.remove(alvo)


def mesclar_atalhos(raiz: str, secoes_ok: set) -> list:
    """Junta ao keys.json só as seções do próprio layout ou mod; o resto o usuário decide."""
    origem = next((os.path.join(d, a) for d, _, fs in os.walk(raiz) if ".git" not in d for a in fs if a in ("keys.json", "KEYS.json")), None)
    if not origem:
        return []
    kp = os.path.join(APP, "keys.json")
    try:
        novas = json.load(open(origem, encoding="utf-8"))
        keys = json.load(open(kp, encoding="utf-8"))
    except (OSError, ValueError):
        return []
    usadas = [s for s in novas if s in secoes_ok]
    if usadas:
        for s in usadas:
            keys[s] = novas[s]
        with open(kp, "w", encoding="utf-8") as f:
            json.dump(keys, f, indent=2, ensure_ascii=False)
    return usadas


def instalar(ident: str) -> dict:
    raiz = os.path.join(CACHE, ident)
    if not os.path.isdir(raiz):
        raise ValueError("inspecione o link antes de instalar")
    p = pecas(raiz)
    if conflitos(p, ident):
        raise ValueError("já existe algo com o mesmo nome: " + ", ".join(conflitos(p, ident)))
    reg = registro()
    for rel in reg.get(ident, {}).get("arquivos", []):  # reinstalar = atualizar
        apagar(rel)
    arquivos = []
    for n in p["layouts"]:
        for ext in (".json", ".png", ".svg"):
            o = os.path.join(raiz, "layouts", n + ext)
            if os.path.exists(o):
                shutil.copy2(o, os.path.join(APP, "layouts", n + ext))
                arquivos.append(f"layouts/{n}{ext}")
        arquivos.append(f"layouts/.state/{n}.json")  # cliques do layout: somem junto
    for n in p["mods"]:
        o = raiz if p.get("mod_na_raiz") else os.path.join(raiz, "mods", n)
        shutil.copytree(o, os.path.join(APP, "mods", n), ignore=shutil.ignore_patterns(".git", ".DS_Store"))
        arquivos.append(f"mods/{n}")
    os.makedirs(os.path.join(APP, "themes"), exist_ok=True)
    for n in p["temas"]:
        shutil.copy2(os.path.join(raiz, "themes", n + ".json"), os.path.join(APP, "themes", n + ".json"))
        arquivos.append(f"themes/{n}.json")
    secoes = mesclar_atalhos(raiz, {f"layout:{n}" for n in p["layouts"]} | {f"mod:{n}" for n in p["mods"]})
    try:
        origem = open(os.path.join(raiz, ".origem"), encoding="utf-8").read().strip()
    except OSError:
        origem = reg.get(ident, {}).get("origem", "")
    reg[ident] = {"origem": origem, "tipo": "layout" if p["layouts"] else "tema",
                  "layout": p["layouts"][0] if p["layouts"] else None, "temas": p["temas"],
                  "arquivos": arquivos, "atalhos": secoes}
    gravar_registro(reg)
    shutil.rmtree(raiz, onerror=_forcar)
    return {"ok": True, "id": ident, "layout": reg[ident]["layout"], "temas": p["temas"], "atalhos": secoes}


def remover(ident: str) -> dict:
    reg = registro()
    if ident not in reg:
        raise ValueError(f"{ident} não foi instalado pelo Temas")
    item = reg.pop(ident)
    for rel in item.get("arquivos", []):
        apagar(rel)
    if item.get("atalhos"):
        kp = os.path.join(APP, "keys.json")
        keys = json.load(open(kp, encoding="utf-8"))
        for s in item["atalhos"]:
            keys.pop(s, None)
        with open(kp, "w", encoding="utf-8") as f:
            json.dump(keys, f, indent=2, ensure_ascii=False)
    gravar_registro(reg)
    return {"ok": True, "removido": ident}


def adotar(ident: str, origem: str, arquivos: list) -> dict:
    reg = registro()
    layouts = [os.path.splitext(os.path.basename(a))[0] for a in arquivos if a.startswith("layouts/") and a.endswith(".json") and "/.state/" not in a]
    temas = [os.path.splitext(os.path.basename(a))[0] for a in arquivos if a.startswith("themes/")]
    atalhos = [f"layout:{n}" for n in layouts]
    reg[ident] = {"origem": origem, "tipo": "layout" if layouts else "tema", "layout": layouts[0] if layouts else None,
                  "temas": temas, "arquivos": arquivos, "atalhos": atalhos}
    gravar_registro(reg)
    return {"ok": True, "id": ident}


def main() -> int:
    args = sys.argv[1:]
    try:
        if args[:1] == ["listar"]:
            saida(listar())
        elif args[:1] == ["inspecionar"] and len(args) == 2:
            saida(inspecionar(args[1]))
        elif args[:1] == ["instalar"] and len(args) == 2:
            saida(instalar(args[1]))
        elif args[:1] == ["remover"] and len(args) == 2:
            saida(remover(args[1]))
        elif args[:1] == ["adotar"] and len(args) >= 4:
            saida(adotar(args[1], args[2], args[3:]))
        else:
            saida({"erro": "uso: temas.py listar | inspecionar <link> | instalar <id> | remover <id>"})
            return 2
    except Exception as e:  # noqa: BLE001 - o erro vai para a tela do mod
        saida({"erro": str(e)})
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
