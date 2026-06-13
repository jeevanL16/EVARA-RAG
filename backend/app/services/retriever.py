"""
Hybrid Retrieval Service
- BM25 sparse search
- Dense vector search
- Multi-query expansion
- Parent-child / neighbor chunk retrieval
- Cross-document deduplication
- FlashRank cross-encoder reranking
- Context compression
"""
import re
import logging
from typing import List, Dict, Any, Optional
from dataclasses import dataclass

from rank_bm25 import BM25Okapi
from app.core.config import settings
from app.services.vector_store import vector_store

logger = logging.getLogger(__name__)

_reranker = None


def get_reranker():
    global _reranker
    if _reranker is None:
        try:
            from flashrank import Ranker
            _reranker = Ranker(model_name="ms-marco-MiniLM-L-12-v2", cache_dir="/tmp/flashrank")
            logger.info("FlashRank reranker loaded.")
        except Exception as e:
            logger.warning(f"FlashRank unavailable: {e}. Falling back to score-based ranking.")
            _reranker = None
    return _reranker


@dataclass
class RetrievedChunk:
    chunk_id: str
    text: str
    filename: str
    page_number: int
    score: float
    metadata: Dict[str, Any]

    def to_dict(self) -> Dict:
        return {
            "chunk_id": str(self.chunk_id),
            "text": str(self.text),
            "filename": str(self.filename),
            "page_number": int(self.page_number),
            "score": round(float(self.score), 4),
            "metadata": {k: str(v) for k, v in self.metadata.items()},
        }


class HybridRetriever:

    def retrieve(
        self,
        query: str,
        mode: str = "normal",
        top_k: int = None,
        doc_ids: Optional[List[str]] = None,
    ) -> List[RetrievedChunk]:
        top_k = top_k or settings.TOP_K_RERANK

        # 1. Dense vector search
        dense_hits = vector_store.dense_search(query, mode=mode, top_k=settings.TOP_K_DENSE, doc_ids=doc_ids)

        # 2. BM25 search on dense hits corpus (lightweight, no separate index needed for now)
        bm25_hits = self._bm25_search(query, dense_hits)

        # 3. Multi-query expansion
        expanded_queries = self._expand_query(query)
        for eq in expanded_queries:
            extra = vector_store.dense_search(eq, mode=mode, top_k=10, doc_ids=doc_ids)
            dense_hits.extend(extra)

        # 4. Combine and deduplicate
        combined = self._deduplicate(dense_hits + bm25_hits)

        # 5. Add neighbor chunks for context
        combined = self._add_neighbors(combined, mode)

        # 6. Rerank
        reranked = self._rerank(query, combined)

        # 7. Take top_k
        top = reranked[:top_k]

        return [
            RetrievedChunk(
                chunk_id=str(h.get("id", h["metadata"].get("chunk_id", ""))),
                text=str(h["text"]),
                filename=str(h["metadata"].get("filename", "")),
                page_number=int(h["metadata"].get("page_number", 0)),
                score=float(h.get("score", 0.0)),
                metadata={k: str(v) for k, v in h["metadata"].items()},
            )
            for h in top
        ]

    def _bm25_search(self, query: str, corpus: List[Dict]) -> List[Dict]:
        """Run BM25 over the dense-retrieved corpus."""
        if not corpus:
            return []
        tokenized = [self._tokenize(d["text"]) for d in corpus]
        tokenized_query = self._tokenize(query)
        try:
            bm25 = BM25Okapi(tokenized)
            scores = bm25.get_scores(tokenized_query)
            for i, doc in enumerate(corpus):
                doc["bm25_score"] = float(scores[i])
            # Return top BM25 hits
            sorted_by_bm25 = sorted(corpus, key=lambda x: x.get("bm25_score", 0), reverse=True)
            return sorted_by_bm25[: settings.TOP_K_BM25]
        except Exception as e:
            logger.warning(f"BM25 error: {e}")
            return []

    def _tokenize(self, text: str) -> List[str]:
        return re.findall(r'\b\w+\b', text.lower())

    def _expand_query(self, query: str) -> List[str]:
        """Simple rule-based query expansion for security and general modes."""
        expansions = []
        q = query.lower()

        # Security domain expansions
        if any(w in q for w in ["vulnerability", "cve", "exploit"]):
            expansions.append(f"vulnerability severity impact {query}")
        if any(w in q for w in ["port", "service", "open"]):
            expansions.append(f"network service port scan {query}")
        if any(w in q for w in ["risk", "critical", "high"]):
            expansions.append(f"risk assessment recommendations {query}")

        # General expansions
        if any(w in q for w in ["summary", "overview", "what"]):
            expansions.append(f"key findings conclusions {query}")
        if any(w in q for w in ["how", "explain", "describe"]):
            expansions.append(f"details explanation {query}")

        return expansions[:2]  # cap at 2

    def _add_neighbors(self, hits: List[Dict], mode: str) -> List[Dict]:
        """
        Add neighboring chunks (same doc, adjacent pages) for context.
        Lightweight: just re-query for chunks with page_number ±1.
        """
        extra = []
        seen_ids = {h.get("id", "") for h in hits}

        for hit in hits[:5]:  # Only for top 5 to avoid explosion
            meta = hit.get("metadata", {})
            doc_id = meta.get("doc_id", "")
            page = int(meta.get("page_number", 0))
            if not doc_id:
                continue
            for neighbor_page in [page - 1, page + 1]:
                if neighbor_page < 1:
                    continue
                try:
                    col = vector_store.get_collection(mode) if False else None  # placeholder
                    # Use chroma get with page filter
                    from app.services.vector_store import get_collection
                    collection = get_collection(mode)
                    results = collection.get(
                        where={"$and": [
                            {"doc_id": doc_id},
                            {"page_number": neighbor_page},
                        ]},
                        include=["documents", "metadatas"],
                        limit=2,
                    )
                    for cid, doc, nmeta in zip(results["ids"], results["documents"], results["metadatas"]):
                        if cid not in seen_ids:
                            extra.append({"id": cid, "text": doc, "metadata": nmeta, "score": hit.get("score", 0) * 0.8})
                            seen_ids.add(cid)
                except Exception:
                    pass

        return hits + extra

    def _deduplicate(self, hits: List[Dict]) -> List[Dict]:
        """Remove duplicate chunks by chunk_id or near-identical text."""
        seen_ids = set()
        seen_texts = set()
        unique = []
        for h in hits:
            cid = h.get("id", h["metadata"].get("chunk_id", ""))
            text_sig = h["text"][:100]
            if cid in seen_ids or text_sig in seen_texts:
                continue
            seen_ids.add(cid)
            seen_texts.add(text_sig)
            unique.append(h)
        return unique

    def _rerank(self, query: str, hits: List[Dict]) -> List[Dict]:
        """Rerank using FlashRank. Fall back to score sort if unavailable."""
        if not hits:
            return hits
        ranker = get_reranker()
        if ranker is None:
            return sorted(hits, key=lambda x: x.get("score", 0), reverse=True)

        try:
            from flashrank import RerankRequest
            passages = [{"id": i, "text": h["text"]} for i, h in enumerate(hits)]
            request = RerankRequest(query=query, passages=passages)
            result = ranker.rerank(request)
            # Map results back
            reranked = []
            for r in result:
                idx = r["id"]
                hits[idx]["score"] = r.get("score", hits[idx].get("score", 0))
                reranked.append(hits[idx])
            return reranked
        except Exception as e:
            logger.warning(f"FlashRank reranking failed: {e}. Using fallback.")
            return sorted(hits, key=lambda x: x.get("score", 0), reverse=True)

    def compress_context(self, chunks: List[RetrievedChunk], max_chars: int = None) -> str:
        """
        Compress retrieved chunks into a concise context string.
        Strips repetition, limits total size.
        """
        max_chars = max_chars or settings.CONTEXT_WINDOW
        seen_sigs = set()
        parts = []
        total = 0

        for chunk in chunks:
            sig = chunk.text[:80]
            if sig in seen_sigs:
                continue
            seen_sigs.add(sig)

            header = f"[{chunk.filename} | Page {chunk.page_number} | Score: {chunk.score:.3f}]\n"
            body = chunk.text.strip()

            entry = header + body + "\n\n"
            if total + len(entry) > max_chars:
                # Add truncated version
                remaining = max_chars - total - len(header) - 10
                if remaining > 100:
                    parts.append(header + body[:remaining] + "...\n\n")
                break
            parts.append(entry)
            total += len(entry)

        return "".join(parts)


retriever = HybridRetriever()