"""
Unit tests for the health check endpoint.
This is the only test that can run in Phase 0 — it requires no database,
no Redis, and no external services. All other tests are added in later phases
alongside the domain logic they test.
"""

from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


def test_health_returns_200():
    response = client.get("/api/health")
    assert response.status_code == 200


def test_health_returns_correct_body():
    response = client.get("/api/health")
    body = response.json()
    assert body["status"] == "ok"
    assert "version" in body


def test_health_content_type_is_json():
    response = client.get("/api/health")
    assert "application/json" in response.headers["content-type"]
