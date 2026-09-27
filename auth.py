"""共通パスワードによるログイン（署名付き Cookie のセッション）"""

import asyncio
import hashlib
import hmac
import os
import secrets
import time
from urllib.parse import quote

from fastapi import APIRouter, Form, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse

from db import BASE_DIR, DATA_DIR

# パスワードは環境変数 APP_PASSWORD（.env）で設定する。
# 未設定のときは起動のたびにランダムなパスワードを作り、ログに表示する（パスワード無しで公開しないため）
PASSWORD = os.environ.get("APP_PASSWORD", "")
if not PASSWORD:
    PASSWORD = secrets.token_urlsafe(9)
    print(f"[auth] APP_PASSWORD が未設定のため、仮のパスワードを作成しました: {PASSWORD}"
          "（.env に APP_PASSWORD を設定してください）", flush=True)
COOKIE = "gantt_session"
MAX_AGE = 7 * 24 * 3600  # ログインの有効期間: 7 日

router = APIRouter(include_in_schema=False)


def _secret_key() -> bytes:
    """署名用の秘密鍵。環境変数 SECRET_KEY、なければデータフォルダに生成して保存（再起動してもログインが切れない）"""
    if os.environ.get("SECRET_KEY"):
        return os.environ["SECRET_KEY"].encode()
    path = DATA_DIR / ".secret_key"
    if not path.exists():
        path.write_text(secrets.token_hex(32))
        path.chmod(0o600)
    return path.read_text().strip().encode()


SECRET = _secret_key()
# パスワードを変えたら既存のログインは無効になるよう、署名にパスワードのハッシュを含める
_PW_TAG = hashlib.sha256(PASSWORD.encode()).hexdigest()[:16]


def _sign(expires: int) -> str:
    return hmac.new(SECRET, f"{expires}:{_PW_TAG}".encode(), hashlib.sha256).hexdigest()


def make_token() -> str:
    expires = int(time.time()) + MAX_AGE
    return f"{expires}.{_sign(expires)}"


def is_valid(token: str | None) -> bool:
    if not token or "." not in token:
        return False
    exp, sig = token.split(".", 1)
    if not exp.isdigit() or int(exp) < time.time():
        return False
    return hmac.compare_digest(sig, _sign(int(exp)))


def check_password(password: str) -> bool:
    return hmac.compare_digest((password or "").encode(), PASSWORD.encode())


def safe_next(path: str | None) -> str:
    """ログイン後の戻り先はサイト内のパスに限定（外部サイトへの誘導を防ぐ）"""
    if path and path.startswith("/") and not path.startswith("//") and not path.startswith("/login"):
        return path
    return "/"


PUBLIC_PREFIXES = ("/login", "/static/")


async def require_login(request: Request, call_next):
    path = request.url.path
    if path.startswith(PUBLIC_PREFIXES) or is_valid(request.cookies.get(COOKIE)):
        return await call_next(request)
    if path.startswith("/api/"):
        return JSONResponse({"detail": "ログインが必要です"}, status_code=401)
    target = path + (f"?{request.url.query}" if request.url.query else "")
    return RedirectResponse(f"/login?next={quote(target)}", status_code=303)


@router.get("/login")
def login_page(request: Request):
    if is_valid(request.cookies.get(COOKIE)):
        return RedirectResponse(safe_next(request.query_params.get("next")), status_code=303)
    return FileResponse(BASE_DIR / "static" / "login.html")


@router.post("/login")
async def login(password: str = Form(""), next: str = Form("/")):
    if not check_password(password):
        await asyncio.sleep(1)  # 総当たり対策で失敗時は少し待たせる
        return RedirectResponse(f"/login?error=1&next={quote(safe_next(next))}", status_code=303)
    res = RedirectResponse(safe_next(next), status_code=303)
    res.set_cookie(COOKIE, make_token(), max_age=MAX_AGE, httponly=True, samesite="lax",
                   secure=os.environ.get("COOKIE_SECURE") == "1")
    return res


@router.get("/logout")
def logout():
    res = RedirectResponse("/login", status_code=303)
    res.delete_cookie(COOKIE)
    return res
