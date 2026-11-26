#!/usr/bin/env python3
"""Popup do herdr com as últimas conversas do Claude Code de cada pasta.

Lê ~/.claude/projects/<pasta>/<id>.jsonl (um arquivo por conversa, o nome é o
ID) e mostra as LIMITE mais recentes de cada pasta, com título, data e ID.
Enter retoma a escolhida numa aba nova do herdr, na pasta onde ela rodou.

Sem curses: o Python do Windows não traz _curses, então as teclas vêm de
msvcrt (Windows) ou termios (Linux/macOS) e o desenho é ANSI puro.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata

LIMITE = 2  # conversas por pasta no popup; o painel do herdr-app pede mais com --limite
# O que já foi lido de cada .jsonl, pela data e tamanho: só os que mudaram são relidos.
CACHE = os.path.join(tempfile.gettempdir(), "herdr-conversas-cache.json")
COMANDO = "claude --dangerously-skip-permissions --resume {id}"
WINDOWS = os.name == "nt"
SEM_JANELA = 0x08000000 if WINDOWS else 0


# ---------------------------------------------------------------- coleta

def pasta_projetos() -> str:
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    return os.path.join(base, "projects")


def primeiro_prompt(msg: dict) -> str:
    """Texto digitado pela pessoa; vazio para tool_result, comandos e avisos."""
    if msg.get("isMeta") or msg.get("isSidechain"):
        return ""
    conteudo = (msg.get("message") or {}).get("content")
    if isinstance(conteudo, list):
        conteudo = " ".join(c.get("text", "") for c in conteudo if isinstance(c, dict) and c.get("type") == "text")
    if not isinstance(conteudo, str):
        return ""
    texto = " ".join(conteudo.split())
    # <command-name>, <local-command-stdout>, avisos do sistema: não são o pedido.
    return "" if not texto or texto.startswith("<") else texto


def ler_conversa(caminho: str) -> "dict | None":
    cwd, titulo_ia, titulo_proprio, prompt = "", "", "", ""
    try:
        with open(caminho, encoding="utf-8", errors="replace") as f:
            for linha in f:
                # Filtro por substring antes do json.loads: os arquivos chegam a dezenas de MB.
                if '"ai-title"' in linha or '"customTitle"' in linha:
                    try:
                        d = json.loads(linha)
                    except ValueError:
                        continue
                    titulo_ia = d.get("aiTitle") or titulo_ia
                    titulo_proprio = d.get("customTitle") or titulo_proprio
                elif (not prompt or not cwd) and '"type":"user"' in linha:
                    try:
                        d = json.loads(linha)
                    except ValueError:
                        continue
                    cwd = cwd or d.get("cwd", "")
                    prompt = prompt or primeiro_prompt(d)
    except OSError:
        return None
    if not cwd or not (prompt or titulo_ia or titulo_proprio):
        return None  # aberta e fechada sem pedido: nada para retomar
    return {
        "id": os.path.splitext(os.path.basename(caminho))[0],
        "cwd": cwd,
        "titulo": titulo_proprio or titulo_ia or prompt,
        "quando": os.path.getmtime(caminho),
    }


def ler_cache() -> dict:
    try:
        with open(CACHE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def gravar_cache(cache: dict) -> None:
    try:
        tmp = CACHE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cache, f)
        os.replace(tmp, CACHE)
    except OSError:
        pass  # sem cache só fica mais lento


def coletar(limite: int = LIMITE) -> list:
    """[{cwd, conversas: [...]}], pastas da conversa mais recente para a mais antiga."""
    raiz = pasta_projetos()
    grupos = {}
    cache, novo = ler_cache(), {}
    try:
        projetos = os.listdir(raiz)
    except OSError:
        return []
    for nome in projetos:
        pasta = os.path.join(raiz, nome)
        try:
            arquivos = [os.path.join(pasta, a) for a in os.listdir(pasta) if a.endswith(".jsonl")]
        except OSError:
            continue
        arquivos.sort(key=os.path.getmtime, reverse=True)
        achadas = []
        for arq in arquivos:
            try:
                st = os.stat(arq)
            except OSError:
                continue
            marca = [st.st_mtime, st.st_size]
            guardado = cache.get(arq)
            conversa = guardado["dados"] if guardado and guardado["marca"] == marca else ler_conversa(arq)
            novo[arq] = {"marca": marca, "dados": conversa}
            if conversa:
                achadas.append(conversa)
            if len(achadas) == limite:
                break
        for c in achadas:
            grupos.setdefault(normalizar(c["cwd"]), {"cwd": c["cwd"], "conversas": []})["conversas"].append(c)
    lista = list(grupos.values())
    for g in lista:
        g["conversas"].sort(key=lambda c: c["quando"], reverse=True)
        g["conversas"] = g["conversas"][:limite]
    lista.sort(key=lambda g: g["conversas"][0]["quando"], reverse=True)
    # O popup pede menos que o painel: guarda também o que o outro leu, menos arquivos apagados.
    gravar_cache({k: v for k, v in {**cache, **novo}.items() if k in novo or os.path.exists(k)})
    return lista


def texto_da_mensagem(d: dict) -> str:
    """Só o texto de uma linha user/assistant: sem pensamento, ferramenta, resultado ou aviso."""
    if d.get("isMeta") or d.get("isSidechain"):
        return ""
    conteudo = (d.get("message") or {}).get("content")
    if isinstance(conteudo, list):
        conteudo = "\n\n".join(c.get("text", "") for c in conteudo if isinstance(c, dict) and c.get("type") == "text")
    if not isinstance(conteudo, str):
        return ""
    texto = conteudo.strip()
    # <command-name>, <local-command-stdout>, avisos do sistema: não são conversa.
    return "" if texto.startswith("<") else texto


def arquivo_da_conversa(id_: str) -> "str | None":
    raiz = pasta_projetos()
    try:
        return next((c for c in (os.path.join(raiz, p, id_ + ".jsonl") for p in os.listdir(raiz)) if os.path.isfile(c)), None)
    except OSError:
        return None


def renomear(id_: str, titulo: str) -> bool:
    """Grava o nome como o /rename do Claude Code: uma linha custom-title no fim do .jsonl (vale a última)."""
    titulo = " ".join(titulo.split())
    caminho = arquivo_da_conversa(id_)
    if not titulo or not caminho:
        return False
    linha = json.dumps({"type": "custom-title", "customTitle": titulo, "sessionId": id_}, ensure_ascii=False, separators=(",", ":"))
    with open(caminho, "rb+") as f:
        # Sem quebra no fim, a linha nova colaria na última.
        fim = f.seek(0, os.SEEK_END)
        if fim:
            f.seek(fim - 1)
            quebra = f.read(1) != b"\n"
        else:
            quebra = False
        f.write((b"\n" if quebra else b"") + linha.encode("utf-8") + b"\n")
    return True


def ultimas(id_: str, quantas: int = 12, corte: int = 1500) -> list:
    """As últimas `quantas` falas da conversa `id_`, da mais antiga para a mais nova.

    Lê o .jsonl de trás para frente em blocos: o arquivo chega a dezenas de MB, e as
    linhas de api-request-blob ocupam quase tudo. Falas seguidas do mesmo papel viram uma.
    """
    caminho = arquivo_da_conversa(id_)
    if not caminho:
        return []
    falas, sobra, BLOCO, MAX = [], b"", 1 << 21, 64 << 20
    with open(caminho, "rb") as f:
        fim = f.seek(0, os.SEEK_END)
        pos = fim
        while pos > 0 and fim - pos < MAX and len(falas) <= quantas:
            ini = max(0, pos - BLOCO)
            f.seek(ini)
            partes = (f.read(pos - ini) + sobra).split(b"\n")
            # A primeira parte pode ser meia linha: espera o bloco anterior, salvo no começo do arquivo.
            sobra = partes.pop(0) if ini > 0 else b""
            pos = ini
            for bruta in reversed(partes):
                if b'"type":"user"' not in bruta and b'"type":"assistant"' not in bruta:
                    continue
                try:
                    d = json.loads(bruta.decode("utf-8", "replace"))
                except ValueError:
                    continue
                papel = d.get("type")
                if papel not in ("user", "assistant"):
                    continue
                texto = texto_da_mensagem(d)
                if not texto:
                    continue
                if falas and falas[-1]["papel"] == papel:
                    # Lendo de trás para frente: o texto mais antigo vai na frente, e a hora é a do começo.
                    falas[-1]["texto"] = texto + "\n\n" + falas[-1]["texto"]
                    falas[-1]["quando"] = d.get("timestamp", falas[-1]["quando"])
                else:
                    falas.append({"papel": papel, "texto": texto, "quando": d.get("timestamp", "")})
    falas = falas[:quantas]
    # Do pedido fica o começo; da resposta, o fim, onde está a conclusão.
    for fala in falas:
        if len(fala["texto"]) > corte:
            t = fala["texto"]
            fala["texto"] = t[:corte].rstrip() + " …" if fala["papel"] == "user" else "… " + t[-corte:].lstrip()
    return list(reversed(falas))


def normalizar(p: str) -> str:
    return os.path.normcase(os.path.normpath(p)).rstrip("\\/")


# ---------------------------------------------------------------- ações

def herdr(*args: str) -> dict:
    binario = os.environ.get("HERDR_BIN_PATH") or shutil.which("herdr") or "herdr"
    r = subprocess.run([binario, *args], capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=20, creationflags=SEM_JANELA)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout).strip() or f"herdr {args[0]} falhou")
    return json.loads(r.stdout).get("result", {})


def achar(obj, chave: str):
    """Primeiro valor de `chave` em qualquer nível do JSON de resposta."""
    if isinstance(obj, dict):
        if chave in obj:
            return obj[chave]
        obj = list(obj.values())
    if isinstance(obj, list):
        for item in obj:
            v = achar(item, chave)
            if v is not None:
                return v
    return None


def retomar(c: dict) -> None:
    if not os.path.isdir(c["cwd"]):
        raise RuntimeError(f"a pasta não existe mais: {c['cwd']}")
    alvo = normalizar(c["cwd"])
    # Abre como aba no workspace que já tem um painel nessa pasta; senão, workspace novo.
    paineis = herdr("pane", "list").get("panes", [])
    ws = next((p["workspace_id"] for p in paineis if normalizar(p.get("cwd") or "") == alvo), None)
    rotulo = curto(c["titulo"], 24)
    if ws:
        criado = herdr("tab", "create", "--workspace", ws, "--cwd", c["cwd"], "--label", rotulo)
    else:
        criado = herdr("workspace", "create", "--cwd", c["cwd"],
                       "--label", os.path.basename(c["cwd"].rstrip("\\/")) or c["cwd"])
    painel, aba, novo_ws = achar(criado, "pane_id"), achar(criado, "tab_id"), achar(criado, "workspace_id")
    if not painel:
        raise RuntimeError("o herdr não devolveu o painel criado")
    herdr("pane", "run", painel, COMANDO.format(id=c["id"]))
    if not ws and novo_ws:
        herdr("workspace", "focus", novo_ws)
    if aba:
        herdr("tab", "focus", aba)


def copiar(texto: str) -> str:
    for cmd in (["clip"] if WINDOWS else [["pbcopy"], ["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "-b"]]):
        cmd = cmd if isinstance(cmd, list) else [cmd]
        if shutil.which(cmd[0]):
            subprocess.run(cmd, input=texto, text=True, creationflags=SEM_JANELA)
            return "comando copiado"
    import base64  # sem ferramenta de clipboard: OSC 52, se o terminal aceitar
    sys.stdout.write("\x1b]52;c;" + base64.b64encode(texto.encode()).decode() + "\x07")
    return "comando enviado por OSC 52"


# ---------------------------------------------------------------- tela

def largura(s: str) -> int:
    return sum(2 if unicodedata.east_asian_width(ch) in "WF" else 0 if unicodedata.combining(ch) else 1 for ch in s)


def curto(s: str, n: int) -> str:
    if largura(s) <= n:
        return s
    out, w = "", 0
    for ch in s:
        cw = largura(ch)
        if w + cw > n - 1:
            break
        out, w = out + ch, w + cw
    return out + "…"


def ajustar(s: str, n: int) -> str:
    s = curto(s, n)
    return s + " " * max(0, n - largura(s))


def data(ts: float) -> str:
    agora = time.localtime()
    t = time.localtime(ts)
    if t.tm_yday == agora.tm_yday and t.tm_year == agora.tm_year:
        return time.strftime("hoje  %H:%M", t)
    return time.strftime("%d/%m %H:%M", t)


class Tela:
    def __init__(self):
        self.grupos = []
        self.sel = 0
        self.topo = 0
        self.aviso = ""

    def carregar(self):
        self.grupos = coletar()
        self.itens = [c for g in self.grupos for c in g["conversas"]]
        self.sel = min(self.sel, max(0, len(self.itens) - 1))

    def linhas(self, larg: int):
        """[(texto, estilo, índice_da_conversa | None)]"""
        out = []
        col_id = 36
        col_data = 11
        col_tit = max(10, larg - col_id - col_data - 8)
        i = 0
        for g in self.grupos:
            nome = os.path.basename(g["cwd"].rstrip("\\/")) or g["cwd"]
            out.append((curto(f" {nome}  {g['cwd']}", larg), "grupo", None))
            for c in g["conversas"]:
                txt = f"   {data(c['quando'])}  {ajustar(c['titulo'], col_tit)}  {c['id']}"
                out.append((ajustar(txt, larg), "item", i))
                i += 1
            out.append(("", "", None))
        return out

    def desenhar(self):
        larg, alt = shutil.get_terminal_size((100, 30))
        corpo = alt - 3
        linhas = self.linhas(larg)
        # Mantém a conversa selecionada (e o cabeçalho da pasta dela) visível.
        pos = next((n for n, l in enumerate(linhas) if l[2] == self.sel), 0)
        if pos - 1 < self.topo:
            self.topo = max(0, pos - 1)
        elif pos >= self.topo + corpo:
            self.topo = pos - corpo + 1
        buf = ["\x1b[H\x1b[2J"]
        buf.append("\x1b[1m" + ajustar(" Conversas do Claude", larg - 1) + "\x1b[0m\r\n")
        buf.append("\x1b[2m" + ajustar(" ↑↓ escolher · Enter retomar · c copiar comando · r atualizar · Esc sair", larg - 1) + "\x1b[0m\r\n")
        for texto, estilo, idx in linhas[self.topo:self.topo + corpo]:
            if estilo == "grupo":
                buf.append("\x1b[1;36m" + texto + "\x1b[0m\r\n")
            elif idx == self.sel:
                buf.append("\x1b[7m" + texto + "\x1b[0m\r\n")
            else:
                buf.append(texto + "\r\n")
        if not linhas:
            buf.append(f" Nenhuma conversa em {pasta_projetos()}\r\n")
        buf.append(f"\x1b[{alt};1H\x1b[33m" + curto(" " + self.aviso, larg - 1) + "\x1b[0m")
        sys.stdout.write("".join(buf))
        sys.stdout.flush()

    def mover(self, d: int):
        if self.itens:
            self.sel = max(0, min(len(self.itens) - 1, self.sel + d))


# ---------------------------------------------------------------- teclado

class Teclado:
    """Devolve 'up', 'down', 'pgup', 'pgdn', 'home', 'end', 'enter', 'esc' ou o caractere."""

    SEQ = {"[A": "up", "[B": "down", "[5~": "pgup", "[6~": "pgdn", "[H": "home", "[F": "end",
           "OA": "up", "OB": "down", "OH": "home", "OF": "end", "[1~": "home", "[4~": "end"}

    def __enter__(self):
        if WINDOWS:
            import ctypes
            k = ctypes.windll.kernel32
            h = k.GetStdHandle(-11)
            modo = ctypes.c_uint32()
            if k.GetConsoleMode(h, ctypes.byref(modo)):
                k.SetConsoleMode(h, modo.value | 0x0004)  # ENABLE_VIRTUAL_TERMINAL_PROCESSING
            sys.stdout.reconfigure(encoding="utf-8")
        else:
            import termios
            import tty
            self.fd = sys.stdin.fileno()
            self.antigo = termios.tcgetattr(self.fd)
            tty.setraw(self.fd)
        sys.stdout.write("\x1b[?1049h\x1b[?25l")
        return self

    def __exit__(self, *_):
        sys.stdout.write("\x1b[?25h\x1b[?1049l")
        sys.stdout.flush()
        if not WINDOWS:
            import termios
            termios.tcsetattr(self.fd, termios.TCSADRAIN, self.antigo)

    def ler(self) -> str:
        if WINDOWS:
            import msvcrt
            ch = msvcrt.getwch()
            if ch in ("\x00", "\xe0"):  # tecla especial do console clássico
                return {"H": "up", "P": "down", "I": "pgup", "Q": "pgdn", "G": "home", "O": "end"}.get(msvcrt.getwch(), "")
            if ch == "\x1b":  # ConPTY com entrada VT: a sequência chega logo atrás
                seq, fim = "", time.time() + 0.05
                while time.time() < fim and len(seq) < 4:
                    if msvcrt.kbhit():
                        seq += msvcrt.getwch()
                        if seq in self.SEQ:
                            break
                    else:
                        time.sleep(0.005)
                return self.SEQ.get(seq, "esc" if not seq else "")
        else:
            dados = os.read(self.fd, 16).decode("utf-8", "replace")
            ch = dados[:1]
            if ch == "\x1b":
                return self.SEQ.get(dados[1:], "esc" if len(dados) == 1 else "")
        if ch in ("\r", "\n"):
            return "enter"
        if ch == "\x03":
            return "esc"
        return ch


def main() -> int:
    tela = Tela()
    tela.carregar()
    with Teclado() as tec:
        while True:
            tela.desenhar()
            k = tec.ler()
            tela.aviso = ""
            if k in ("esc", "q"):
                return 0
            if k in ("up", "k"):
                tela.mover(-1)
            elif k in ("down", "j"):
                tela.mover(1)
            elif k == "pgup":
                tela.mover(-10)
            elif k == "pgdn":
                tela.mover(10)
            elif k == "home":
                tela.sel = 0
            elif k == "end":
                tela.sel = max(0, len(tela.itens) - 1)
            elif k == "r":
                tela.carregar()
                tela.aviso = "lista atualizada"
            elif k == "c" and tela.itens:
                tela.aviso = copiar(COMANDO.format(id=tela.itens[tela.sel]["id"]))
            elif k == "enter" and tela.itens:
                try:
                    retomar(tela.itens[tela.sel])
                    return 0
                except Exception as e:  # noqa: BLE001 - o erro vira aviso na tela
                    tela.aviso = f"erro: {e}"


if __name__ == "__main__":
    if "--listar" in sys.argv:  # diagnóstico fora do popup
        # ASCII com escapes \uXXXX: o stdout de um pipe no Windows é cp1252, e quem
        # lê (o mod do herdr-app) decodifica UTF-8; assim os acentos sobrevivem a qualquer codificação.
        limite = int(sys.argv[sys.argv.index("--limite") + 1]) if "--limite" in sys.argv else LIMITE
        print(json.dumps(coletar(limite), indent=1))
        sys.exit(0)
    if "--ultimas" in sys.argv:  # as últimas falas de uma conversa, para o modal do painel
        print(json.dumps(ultimas(sys.argv[sys.argv.index("--ultimas") + 1])))
        sys.exit(0)
    if "--renomear" in sys.argv:  # o lápis do painel: --renomear <id> <nome>
        i = sys.argv.index("--renomear")
        sys.exit(0 if renomear(sys.argv[i + 1], sys.argv[i + 2]) else 1)
    sys.exit(main())
