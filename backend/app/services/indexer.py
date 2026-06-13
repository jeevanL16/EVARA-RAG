"""
Document index manager.
Orchestrates: parse → chunk → embed → store.
Incremental: only processes changed/new documents.
"""
import uuid
import json
import hashlib
import logging
from pathlib import Path
from typing import Optional
from datetime import datetime, timezone

from app.core.config import settings
from app.services.parser import parser
from app.services.chunker import chunker
from app.services.vector_store import vector_store

logger = logging.getLogger(__name__)

INDEX_REGISTRY = settings.INDEX_DIR / "registry.json"


def _load_registry() -> dict:
    if INDEX_REGISTRY.exists():
        return json.loads(INDEX_REGISTRY.read_text())
    return {}


def _save_registry(reg: dict):
    INDEX_REGISTRY.parent.mkdir(parents=True, exist_ok=True)
    INDEX_REGISTRY.write_text(json.dumps(reg, indent=2))


def _file_hash(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(65536), b""):
            h.update(block)
    return h.hexdigest()


def index_document(file_path: Path, mode: str = "normal") -> dict:
    """Parse, chunk, and index a document. Skip if unchanged (same hash)."""
    registry = _load_registry()
    file_hash = _file_hash(file_path)
    filename = file_path.name

    # Check if already indexed with same hash
    existing = next((v for v in registry.values() if v["filename"] == filename and v["mode"] == mode), None)
    if existing and existing.get("hash") == file_hash:
        logger.info(f"Skipping {filename} — unchanged.")
        return {"doc_id": existing["doc_id"], "status": "unchanged", "chunks": existing["chunks"]}

    # If exists but changed, delete old chunks first
    if existing:
        vector_store.delete_document(existing["doc_id"], mode)
        del registry[existing["doc_id"]]

    doc_id = str(uuid.uuid4())
    parsed = parser.parse(file_path, mode)
    chunks = chunker.chunk_document(parsed, doc_id)

    if not chunks:
        return {"doc_id": doc_id, "status": "empty", "chunks": 0}

    added = vector_store.add_chunks(chunks, mode)

    registry[doc_id] = {
        "doc_id": doc_id,
        "filename": filename,
        "file_path": str(file_path),
        "mode": mode,
        "hash": file_hash,
        "chunks": added,
        "pages": parsed.total_pages,
        "indexed_at": datetime.now(timezone.utc).isoformat(),
        "is_security": parsed.is_security,
    }
    _save_registry(registry)

    logger.info(f"Indexed {filename}: {added} chunks, {parsed.total_pages} pages")
    return {"doc_id": doc_id, "status": "indexed", "chunks": added, "pages": parsed.total_pages}


def delete_document(doc_id: str, mode: str = "normal") -> dict:
    registry = _load_registry()
    if doc_id not in registry:
        return {"status": "not_found"}
    info = registry.pop(doc_id)
    deleted = vector_store.delete_document(doc_id, mode)
    # Remove file
    fp = Path(info.get("file_path", ""))
    if fp.exists():
        fp.unlink(missing_ok=True)
    _save_registry(registry)
    return {"status": "deleted", "chunks_removed": deleted}


def list_documents(mode: str = "normal") -> list:
    registry = _load_registry()
    return [v for v in registry.values() if v.get("mode") == mode]


def get_document(doc_id: str) -> Optional[dict]:
    return _load_registry().get(doc_id)
