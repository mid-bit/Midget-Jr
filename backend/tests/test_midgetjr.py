"""Midget jr. backend API tests."""
import os
import uuid
import pytest
import requests

BASE = os.environ.get("REACT_APP_BACKEND_URL", "https://thought-share-25.preview.emergentagent.com").rstrip("/")
API = f"{BASE}/api"
PASSWORD = "MidgetsRcool"


@pytest.fixture(scope="session")
def token():
    r = requests.post(f"{API}/unlock", json={"password": PASSWORD}, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="session")
def auth_headers(token):
    return {"Authorization": f"Bearer {token}"}


# ── Auth ──
def test_unlock_wrong_password():
    r = requests.post(f"{API}/unlock", json={"password": "nope"}, timeout=30)
    assert r.status_code == 401


def test_unlock_correct_password(token):
    assert isinstance(token, str) and len(token) > 10


# ── Root ──
def test_root():
    r = requests.get(f"{API}/", timeout=30)
    assert r.status_code == 200
    assert r.json().get("ok") is True


# ── Chat ──
def test_chat_basic():
    r = requests.post(f"{API}/chat", json={"message": "Say hello in 3 words."}, timeout=120)
    assert r.status_code == 200, r.text
    d = r.json()
    assert isinstance(d.get("reply"), str) and len(d["reply"]) > 0
    assert d.get("context_used", -1) >= 0


# ── Code ──
def test_code_generation():
    r = requests.post(f"{API}/code", json={"prompt": "function that adds two numbers", "language": "python"}, timeout=120)
    assert r.status_code == 200, r.text
    d = r.json()
    assert isinstance(d.get("code"), str) and len(d["code"]) > 5
    assert d.get("language") == "python"


# ── Import & KB context ──
def test_import_requires_auth():
    r = requests.post(f"{API}/knowledge/import", json={"files": [{"name": "x.txt", "content": "hi"}]}, timeout=30)
    assert r.status_code == 401


def test_import_and_query_and_chat_context(auth_headers):
    unique = f"zorblax{uuid.uuid4().hex[:6]}"
    content = f"The {unique} is a mythical creature found only in the test realm. It glows neon orange."
    payload = {"files": [{"name": f"{unique}.txt", "content": content, "category": "TEST_Imported", "tags": ["test"]}]}
    r = requests.post(f"{API}/knowledge/import", json=payload, headers=auth_headers, timeout=60)
    assert r.status_code == 200, r.text
    d = r.json()
    assert len(d.get("saved", [])) == 1
    assert d.get("errors") == []

    # Query should find it
    r2 = requests.post(f"{API}/query", json={"query": unique}, timeout=30)
    assert r2.status_code == 200
    qd = r2.json()
    assert qd["result_count"] >= 1
    assert any(unique in (e.get("topic") or "") or unique in (e.get("summary") or "") for e in qd["results"])

    # Chat should use the KB context (context_used > 0)
    r3 = requests.post(f"{API}/chat", json={"message": f"What is the {unique}?"}, timeout=120)
    assert r3.status_code == 200, r3.text
    cd = r3.json()
    assert cd.get("context_used", 0) > 0


# ── Research ──
def test_research():
    r = requests.post(f"{API}/research", json={"topic": "Python programming language", "category": "Technology"}, timeout=180)
    assert r.status_code == 200, r.text
    d = r.json()
    assert "topic" in d and "summary" in d and "id" in d
    assert isinstance(d.get("sources_found"), int)


# ── Queue ──
def test_queue_auth_required_post():
    r = requests.post(f"{API}/queue", json={"topic": "test"}, timeout=30)
    assert r.status_code == 401


def test_queue_auth_required_delete():
    r = requests.delete(f"{API}/queue/some-id", timeout=30)
    assert r.status_code == 401


def test_queue_crud(auth_headers):
    topic = f"TEST_topic_{uuid.uuid4().hex[:6]}"
    r = requests.post(f"{API}/queue", json={"topic": topic, "category": "General", "priority": 2}, headers=auth_headers, timeout=30)
    assert r.status_code == 200, r.text
    item = r.json()
    assert item.get("topic") == topic
    assert item.get("status") == "pending"
    qid = item["id"]

    r2 = requests.get(f"{API}/queue", timeout=30)
    assert r2.status_code == 200
    items = r2.json()
    assert any(it.get("id") == qid for it in items)

    r3 = requests.delete(f"{API}/queue/{qid}", headers=auth_headers, timeout=30)
    assert r3.status_code == 200
    assert r3.json().get("deleted") == qid

    # Verify deleted
    r4 = requests.get(f"{API}/queue", timeout=30)
    assert not any(it.get("id") == qid for it in r4.json())
