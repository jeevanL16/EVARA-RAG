"""EVARA FastAPI backend — all routes."""
import shutil
import logging
from pathlib import Path
from typing import Optional, List
from datetime import datetime

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.core.config import settings
from app.services.indexer import index_document, delete_document, list_documents, get_document
from app.services.retriever import retriever
from app.services.llm import generate_answer
from app.services.guardrails import check_input, check_output

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="EVARA API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Models ────────────────────────────────────────────────────────────────────

class QueryRequest(BaseModel):
    query: str
    mode: str = "normal"
    doc_ids: Optional[List[str]] = None
    top_k: int = 8

class QueryResponse(BaseModel):
    answer: str
    source: str
    citations: list
    warnings: list
    latency_ms: float

# ── Upload & Index ─────────────────────────────────────────────────────────────

@app.post("/api/upload")
async def upload_file(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    mode: str = Form("normal"),
):
    allowed = settings.ALLOWED_EXTENSIONS_SECURITY if mode == "security" else settings.ALLOWED_EXTENSIONS_NORMAL
    suffix = Path(file.filename).suffix.lower()
    if suffix not in allowed:
        raise HTTPException(400, f"File type '{suffix}' not allowed in {mode} mode.")

    save_path = settings.UPLOAD_DIR / file.filename
    with open(save_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    # Index synchronously (could be backgrounded for very large files)
    result = index_document(save_path, mode)
    result["filename"] = file.filename
    result["mode"] = mode
    return result


@app.post("/api/auto-analyze")
async def auto_analyze(doc_id: str, mode: str = "normal"):
    """Trigger automatic analysis right after upload."""
    doc = get_document(doc_id)
    if not doc:
        raise HTTPException(404, "Document not found")

    import time
    start = time.time()

    chunks = retriever.retrieve(
        query="Provide a complete analysis of this document",
        mode=mode,
        doc_ids=[doc_id],
        top_k=12,
    )
    if not chunks:
        return {"answer": "No content could be extracted from this document.", "citations": []}

    context = retriever.compress_context(chunks)
    result = generate_answer("", chunks, context, mode, analysis_type="auto_analysis")
    _, warnings = check_output(result["answer"], [c.text for c in chunks])

    return {
        "answer": result["answer"],
        "source": result["source"],
        "citations": [c.to_dict() for c in chunks[:8]],
        "warnings": warnings,
        "latency_ms": round((time.time() - start) * 1000, 1),
    }


# ── Query ─────────────────────────────────────────────────────────────────────

@app.post("/api/query", response_model=QueryResponse)
async def query(req: QueryRequest):
    import time
    start = time.time()

    # Input guardrail
    safe, reason = check_input(req.query)
    if not safe:
        return QueryResponse(
            answer=f"⚠ Query blocked: {reason}",
            source="guardrail",
            citations=[],
            warnings=[reason],
            latency_ms=0,
        )

    chunks = retriever.retrieve(req.query, req.mode, req.top_k, req.doc_ids)
    if not chunks:
        return QueryResponse(
            answer="No relevant content found in the uploaded documents for this query.",
            source="no_results",
            citations=[],
            warnings=[],
            latency_ms=round((time.time() - start) * 1000, 1),
        )

    context = retriever.compress_context(chunks)
    result = generate_answer(req.query, chunks, context, req.mode)
    answer, warnings = check_output(result["answer"], [c.text for c in chunks])

    return QueryResponse(
        answer=answer,
        source=result["source"],
        citations=[c.to_dict() for c in chunks],
        warnings=warnings,
        latency_ms=round((time.time() - start) * 1000, 1),
    )


# ── CRUD ──────────────────────────────────────────────────────────────────────

@app.get("/api/documents")
def get_documents(mode: str = "normal"):
    return list_documents(mode)


@app.delete("/api/documents/{doc_id}")
def remove_document(doc_id: str, mode: str = "normal"):
    result = delete_document(doc_id, mode)
    if result["status"] == "not_found":
        raise HTTPException(404, "Document not found")
    return result


@app.get("/api/documents/{doc_id}")
def get_doc(doc_id: str):
    doc = get_document(doc_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    return doc


@app.get("/api/health")
def health():
    from app.services.vector_store import vector_store
    return {
        "status": "ok",
        "normal_chunks": vector_store.collection_count("normal"),
        "security_chunks": vector_store.collection_count("security"),
        "timestamp": datetime.utcnow().isoformat(),
    }
