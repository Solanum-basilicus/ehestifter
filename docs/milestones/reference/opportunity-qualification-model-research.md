# Opportunity Qualification — model research notes

**Optional reference only.** Read during Phase 2 or when a model selection is blocked. Do not load during standard implementation sessions. Canonical milestone: [`../opportunity-qualification.md`](../opportunity-qualification.md).

## Research question

Can a smaller local model maintain useful, grounded GEO and language evidence, and can a smaller scoring/ranking model maintain actual job–CV ranking quality? Performance means sustained successful tasks/hour on the local AMD/ROCm node, not vendor token/sec claims. Separate model inference from orchestration, SQL, cold starts, and container overhead.

## Candidate directions to verify after Phase 1

The following links are **research leads, not approved deployments**. Model version, license, distribution, hardware support, context, inputs, output schema and benchmark claims need fresh verification.

| Task | Candidate direction | Why examine | Key risk |
| --- | --- | --- | --- |
| Shared GEO/language fact extraction | [GLiNER2](https://huggingface.co/fastino/gliner2-large-v1) / newer multilingual variants | Source-span extraction and structured classification | May miss relations and negation |
| Shared language requirement classification | [Laya](https://huggingface.co/convaiinnovations/laya) | Small non-generative typed decisions | Does not generate new language names or exact quotes |
| Shared structured extraction | [LFM2 Extract](https://huggingface.co/LiquidAI/LFM2-1.2B-Extract-GGUF), [NuExtract3](https://huggingface.co/numind/NuExtract3-GGUF) | Models aimed at extraction/structured fields | License/runtime and overconfident incorrect fields |
| Small local generator | [Gemma family](https://huggingface.co/google), [Ministral family](https://huggingface.co/mistralai), [Granite family](https://huggingface.co/ibm-granite) | Independent model families for comparison | Actual context, license and ROCm/llama.cpp support |
| Compatibility cross-encoder | [job-eval ModernBERT](https://huggingface.co/kasraahmadi/job-eval-modernbert) | Job/CV-specific ranking baseline | Input length and LLM-derived training labels |
| Compatibility embeddings | [Resumator](https://huggingface.co/shankerram3/resumator) | Cheap ranking baseline | Similarity is not calibrated 0–10 fit score |
| Generative reference | Existing Qwen model and smaller/limited-thinking Qwen settings | Contract and output-quality baseline | GPU memory, reasoning time and score instability |

Do not include hosted-only decision models in the local deployment shortlist, unless the operator explicitly accepts external inference. For example, Jev is not assumed to provide open weights for a local container.

## Narrow follow-up research: required outputs

Use actual error cases and latency from Phase 1 before selecting models. Search for newer variants or task-specific fine-tunes with documented provenance and legally usable weights. Check these factors for each shortlisted candidate:

1. Task fit: entity extraction, mandatory/optional classification, Boolean language conditions, numerical ranking, or score plus explanation.
2. Input fit: long job descriptions and long CVs, truncation policy, multiple languages, exact quote evidence.
3. Quality evidence: public evaluations and domain differences; risk from synthetic labels; manual Ehestifter hold-out still required.
4. Runtime fit: compatible architecture and image, GPU/CPU support, VRAM/RAM, batching, model startup and shutdown.
5. Reliability: strict schema, score range, calibration, repeated-run variation, failure under long inputs.
6. Licensing, model revision and quantization reproducibility.

Output only a small ranked shortlist and targeted benchmark configurations. Do not add candidates merely to increase the model count. Do not copy the whole research report into the milestone file.
