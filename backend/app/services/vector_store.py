"""
ChromaDB vector store service.
Supports incremental CRUD — never rebuilds the entire index.
Collections: evara_normal, evara_security
"""
import logging
import hashlib
from typing import List, Dict, Any, Optional, Tuple

import chromadb
from chromadb.config import Settings as ChromaSettings
from sentence_transformers import SentenceTransformer

from app.core.config import settings
from app.services.chunker import Chunk

logger = logging.getLogger(__name__)

_embedding_model: Optional[SentenceTransformer] = None
_chroma_client: Optional[chromadb.PersistentClient] = None


def get_embedding_model() -> SentenceTransformer:
    global _embedding_model
    if _embedding_model is None:
        logger.info(f"Loading embedding model: {settings.EMBEDDING_MODEL}")
        _embedding_model = SentenceTransformer(settings.EMBEDDING_MODEL)
        logger.info("Embedding model loaded.")
    return _embedding_model


def get_chroma_client() -> chromadb.PersistentClient:
    global _chroma_client
    if _chroma_client is None:
        _chroma_client = chromadb.PersistentClient(
            path=str(settings.CHROMA_DIR),
            settings=ChromaSettings(anonymized_telemetry=False),
        )
    return _chroma_client


def get_collection(mode: str = "normal") -> chromadb.Collection:
    client = get_chroma_client()
    name = settings.SECURITY_COLLECTION if mode == "security" else settings.NORMAL_COLLECTION
    return client.get_or_create_collection(
        name=name,
        metadata={"hnsw:space": "cosine"},
    )


class VectorStore:

    def embed_texts(self, texts: List[str]) -> List[List[float]]:
        model = get_embedding_model()
        return model.encode(texts, show_progress_bar=False, batch_size=64).tolist()

    # ─────────────────────────────────────────────
    # CRUD
    # ─────────────────────────────────────────────

    def add_chunks(self, chunks: List[Chunk], mode: str = "normal") -> int:
        """Add new chunks. Skips duplicates by chunk_id."""
        if not chunks:
            return 0
        collection = get_collection(mode)

        # Batch to avoid memory spikes
        batch_size = 512
        added = 0
        for i in range(0, len(chunks), batch_size):
            batch = chunks[i:i + batch_size]
            ids = [c.chunk_id for c in batch]
            texts = [c.text for c in batch]
            metadatas = [c.to_chroma_metadata() for c in batch]

            # Skip already-existing IDs
            try:
                existing = collection.get(ids=ids, include=[])
                existing_ids = set(existing["ids"])
                new_batch = [(i, t, m) for i, t, m in zip(ids, texts, metadatas) if i not in existing_ids]
            except Exception:
                new_batch = list(zip(ids, texts, metadatas))

            if not new_batch:
                continue

            new_ids, new_texts, new_metas = zip(*new_batch)
            embeddings = self.embed_texts(list(new_texts))
            collection.add(
                ids=list(new_ids),
                embeddings=embeddings,
                documents=list(new_texts),
                metadatas=list(new_metas),
            )
            added += len(new_ids)

        logger.info(f"Added {added} chunks to '{mode}' collection")
        return added

    def update_chunks(self, chunks: List[Chunk], mode: str = "normal") -> int:
        """Upsert chunks (update if exists, add if not)."""
        if not chunks:
            return 0
        collection = get_collection(mode)
        batch_size = 512
        updated = 0
        for i in range(0, len(chunks), batch_size):
            batch = chunks[i:i + batch_size]
            ids = [c.chunk_id for c in batch]
            texts = [c.text for c in batch]
            metadatas = [c.to_chroma_metadata() for c in batch]
            embeddings = self.embed_texts(texts)
            collection.upsert(
                ids=ids,
                embeddings=embeddings,
                documents=texts,
                metadatas=metadatas,
            )
            updated += len(ids)
        logger.info(f"Upserted {updated} chunks in '{mode}' collection")
        return updated

    def delete_document(self, doc_id: str, mode: str = "normal") -> int:
        """Delete all chunks belonging to a document."""
        collection = get_collection(mode)
        try:
            results = collection.get(where={"doc_id": doc_id}, include=["metadatas"])
            ids = results["ids"]
            if ids:
                collection.delete(ids=ids)
            logger.info(f"Deleted {len(ids)} chunks for doc_id={doc_id}")
            return len(ids)
        except Exception as e:
            logger.error(f"Delete failed for doc_id={doc_id}: {e}")
            return 0

    def get_document_chunks(self, doc_id: str, mode: str = "normal") -> List[Dict]:
        """Return all chunks for a specific document."""
        collection = get_collection(mode)
        results = collection.get(where={"doc_id": doc_id}, include=["documents", "metadatas"])
        chunks = []
        for cid, doc, meta in zip(results["ids"], results["documents"], results["metadatas"]):
            chunks.append({"id": cid, "text": doc, "metadata": meta})
        return chunks

    def list_documents(self, mode: str = "normal") -> List[Dict]:
        """Return distinct documents in the collection."""
        collection = get_collection(mode)
        try:
            results = collection.get(include=["metadatas"])
            seen = {}
            for meta in results["metadatas"]:
                doc_id = meta.get("doc_id", "")
                if doc_id and doc_id not in seen:
                    seen[doc_id] = {
                        "doc_id": doc_id,
                        "filename": meta.get("filename", ""),
                        "total_chunks": 0,
                    }
                if doc_id:
                    seen[doc_id]["total_chunks"] += 1
            return list(seen.values())
        except Exception as e:
            logger.error(f"list_documents error: {e}")
            return []

    # ─────────────────────────────────────────────
    # Dense vector search
    # ─────────────────────────────────────────────

    def dense_search(
        self,
        query: str,
        mode: str = "normal",
        top_k: int = None,
        doc_ids: Optional[List[str]] = None,
    ) -> List[Dict]:
        top_k = top_k or settings.TOP_K_DENSE
        collection = get_collection(mode)
        embedding = self.embed_texts([query])[0]

        where_filter = {"doc_id": {"$in": doc_ids}} if doc_ids else None

        try:
            results = collection.query(
                query_embeddings=[embedding],
                n_results=min(top_k, collection.count() or 1),
                where=where_filter,
                include=["documents", "metadatas", "distances"],
            )
        except Exception as e:
            logger.error(f"Dense search error: {e}")
            return []

        hits = []
        for doc, meta, dist in zip(
            results["documents"][0],
            results["metadatas"][0],
            results["distances"][0],
        ):
            hits.append({
                "text": doc,
                "metadata": meta,
                "score": 1 - dist,  # cosine distance → similarity
            })
        return hits

    def collection_count(self, mode: str = "normal") -> int:
        try:
            return get_collection(mode).count()
        except Exception:
            return 0


vector_store = VectorStore()
