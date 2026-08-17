from __future__ import annotations

import json
import unittest
from unittest.mock import Mock

import requests

from app.llama_cpp_client import LlamaCppClient, LlamaCppProtocolError


class FakeResponse:
    def __init__(
        self,
        *,
        json_data=None,
        lines=None,
        status_code: int = 200,
        text: str = "",
    ):
        self._json_data = json_data
        self._lines = list(lines or [])
        self.status_code = status_code
        self.text = text
        self.closed = False
        self.iter_line_chunk_sizes: list[int | None] = []

    def raise_for_status(self):
        if self.status_code >= 400:
            response = requests.Response()
            response.status_code = self.status_code
            response._content = self.text.encode("utf-8")
            raise requests.HTTPError(response=response)

    def json(self):
        if isinstance(self._json_data, BaseException):
            raise self._json_data
        return self._json_data

    def iter_lines(self, chunk_size=None, decode_unicode=False):
        del decode_unicode
        self.iter_line_chunk_sizes.append(chunk_size)
        yield from self._lines

    def close(self):
        self.closed = True


class TimeoutStreamResponse(FakeResponse):
    def iter_lines(self, chunk_size=None, decode_unicode=False):
        del chunk_size, decode_unicode
        yield from sse_chunk(chat_chunk(reasoning="partial", predicted_n=10))
        raise requests.Timeout("stream timed out")


def sse_chunk(data: dict) -> list[str]:
    return [f"data: {json.dumps(data)}", ""]


def chat_chunk(
    *,
    completion_id: str = "chatcmpl-1",
    reasoning: str | None = None,
    content: str | None = None,
    predicted_n: int | None = None,
    finish_reason: str | None = None,
) -> dict:
    delta = {}
    if reasoning is not None:
        delta["reasoning_content"] = reasoning
    if content is not None:
        delta["content"] = content

    chunk = {
        "id": completion_id,
        "model": "model-a",
        "created": 1,
        "choices": [{"delta": delta, "finish_reason": finish_reason}],
    }
    if predicted_n is not None:
        chunk["timings"] = {"predicted_n": predicted_n}
    return chunk


class LlamaCppClientTests(unittest.TestCase):
    def setUp(self):
        self.client = LlamaCppClient("http://llama.test", timeout_s=30)
        self.client.session = Mock()

    def generate(self, *, budget=None):
        return self.client.generate_json(
            model="model-a",
            prompt="prompt",
            system="system",
            temperature=0.2,
            top_p=0.95,
            num_predict=2000,
            enable_thinking=True,
            thinking_budget_tokens=budget,
            reasoning_format="deepseek",
            format=None,
        )

    def test_request_without_budget_uses_existing_synchronous_path(self):
        self.client.session.post.return_value = FakeResponse(
            json_data={
                "id": "chatcmpl-sync",
                "model": "model-a",
                "created": 1,
                "choices": [
                    {
                        "message": {"content": '{"score": 0}', "reasoning_content": "think"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"completion_tokens": 4},
            }
        )

        result = self.generate(budget=None)

        self.assertEqual(result["score"], 0)
        self.assertEqual(self.client.session.post.call_count, 1)
        _, kwargs = self.client.session.post.call_args
        self.assertFalse(kwargs["json"]["stream"])
        self.assertNotIn("reasoning_control", kwargs["json"])
        self.assertNotIn("thinking_budget_tokens", kwargs["json"])
        self.assertNotIn("stream", kwargs)

    def test_budgeted_request_sends_reasoning_end_once_and_reads_final_content(self):
        lines = []
        lines += sse_chunk(chat_chunk(reasoning="first ", predicted_n=599))
        lines += sse_chunk(chat_chunk(reasoning="second", predicted_n=600))
        lines += sse_chunk(chat_chunk(content='{"score": 7}', predicted_n=603))
        lines += sse_chunk(chat_chunk(predicted_n=604, finish_reason="stop"))
        lines += ["data: [DONE]", ""]
        stream_response = FakeResponse(lines=lines)
        control_response = FakeResponse(json_data={"success": True})
        self.client.session.post.side_effect = [stream_response, control_response]

        result = self.generate(budget=600)

        self.assertEqual(result["score"], 7)
        self.assertEqual(self.client.session.post.call_count, 2)
        first_call = self.client.session.post.call_args_list[0]
        second_call = self.client.session.post.call_args_list[1]
        self.assertEqual(first_call.args[0], "http://llama.test/v1/chat/completions")
        self.assertTrue(first_call.kwargs["json"]["stream"])
        self.assertTrue(first_call.kwargs["json"]["reasoning_control"])
        self.assertNotIn("thinking_budget_tokens", first_call.kwargs["json"])
        self.assertTrue(first_call.kwargs["stream"])
        self.assertEqual(
            second_call.kwargs["json"],
            {"id": "chatcmpl-1", "action": "reasoning_end", "model": "model-a"},
        )
        self.assertTrue(result["__llama_cpp"]["reasoning_control_attempted"])
        self.assertIsNone(result["__llama_cpp"]["reasoning_control_error"])
        self.assertEqual(result["__llama_cpp"]["reasoning_len"], len("first second"))
        self.assertTrue(stream_response.closed)
        self.assertEqual(stream_response.iter_line_chunk_sizes, [1])

    def test_natural_final_content_before_budget_sends_no_control(self):
        lines = []
        lines += sse_chunk(chat_chunk(reasoning="short", predicted_n=20))
        lines += sse_chunk(chat_chunk(content='{"score": 3}', predicted_n=30))
        lines += sse_chunk(chat_chunk(predicted_n=31, finish_reason="stop"))
        lines += ["data: [DONE]", ""]
        self.client.session.post.return_value = FakeResponse(lines=lines)

        result = self.generate(budget=600)

        self.assertEqual(result["score"], 3)
        self.assertEqual(self.client.session.post.call_count, 1)
        self.assertFalse(result["__llama_cpp"]["reasoning_control_attempted"])

    def test_structured_result_uses_final_content_only(self):
        lines = []
        lines += sse_chunk(chat_chunk(reasoning='{"score": 99}', predicted_n=10))
        lines += sse_chunk(chat_chunk(content='{"score": 4}', predicted_n=20))
        lines += sse_chunk(chat_chunk(predicted_n=21, finish_reason="stop"))
        lines += ["data: [DONE]", ""]
        self.client.session.post.return_value = FakeResponse(lines=lines)

        result = self.generate(budget=600)

        self.assertEqual(result["score"], 4)
        self.assertTrue(result["__llama_cpp"]["had_reasoning_content"])

    def test_failed_control_is_visible_and_stream_continues(self):
        lines = []
        lines += sse_chunk(chat_chunk(reasoning="long", predicted_n=600))
        lines += sse_chunk(chat_chunk(reasoning="still thinking", predicted_n=700))
        lines += sse_chunk(chat_chunk(content='{"score": 5}', predicted_n=710))
        lines += sse_chunk(chat_chunk(predicted_n=711, finish_reason="stop"))
        lines += ["data: [DONE]", ""]
        self.client.session.post.side_effect = [
            FakeResponse(lines=lines),
            requests.Timeout("control timed out"),
        ]

        result = self.generate(budget=600)

        self.assertEqual(result["score"], 5)
        self.assertEqual(self.client.session.post.call_count, 2)
        self.assertTrue(result["__llama_cpp"]["reasoning_control_attempted"])
        self.assertIn("Timeout", result["__llama_cpp"]["reasoning_control_error"])

    def test_malformed_sse_does_not_return_partial_result(self):
        lines = []
        lines += sse_chunk(chat_chunk(reasoning="partial", predicted_n=10))
        lines += ["data: {not-json}", ""]
        self.client.session.post.return_value = FakeResponse(lines=lines)

        with self.assertRaises(LlamaCppProtocolError):
            self.generate(budget=600)

    def test_stream_without_finish_reason_does_not_return_partial_result(self):
        lines = []
        lines += sse_chunk(chat_chunk(content='{"score": 1}', predicted_n=10))
        lines += ["data: [DONE]", ""]
        self.client.session.post.return_value = FakeResponse(lines=lines)

        with self.assertRaises(LlamaCppProtocolError):
            self.generate(budget=600)

    def test_stream_timeout_does_not_return_partial_result(self):
        stream_response = TimeoutStreamResponse()
        self.client.session.post.return_value = stream_response

        with self.assertRaises(requests.Timeout):
            self.generate(budget=600)

        self.assertTrue(stream_response.closed)


if __name__ == "__main__":
    unittest.main()
