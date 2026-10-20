"""Tests for strict inference results and the single content retry."""
from __future__ import annotations

import json
import unittest
from types import SimpleNamespace

from app.compatibility import (
    InsufficientJobDescription,
    InvalidCompatibilityResult,
    build_prompt,
    calculate_final_score,
    check_job_description,
    validate_result,
    normalize_result,
)
from app.validated_inference import validate_with_content_retry


def valid_result(score=0):
    return {
        "Description": "Weak fit: the CV does not meet the listed Python and Azure requirements.",
        "Languages": {"Applicant": [], "Job": {"Mandatory": [], "Optional": []}},
        "HardSkills": {"score": score, "description": "The CV does not list Azure."},
        "Experience": {"score": 2, "description": "Relevant experience is limited."},
        "SoftSkills": {"score": 4, "description": "Communication evidence is limited."},
    }


class CompatibilityValidationTests(unittest.TestCase):
    def test_build_prompt_includes_valid_output_structure(self):
        prompt = build_prompt(
            job={"title": "Developer", "description": "Build Python and Azure services."},
            cv_text="Candidate knows Python and SQL.",
        )
        self.assertIn('{"status":"insufficient_job_description"}', prompt)
        self.assertIn("Build Python and Azure services.", prompt)
        self.assertIn("Candidate knows Python and SQL.", prompt)

        header = "Return ONLY a single JSON object with exactly this structure:\n"
        tail = "\n\nCritical interpretation rules:"
        shape_json = prompt.split(header, 1)[1].split(tail, 1)[0]
        shape = json.loads(shape_json)
        self.assertEqual(set(shape), {
            "Description", "Languages", "HardSkills", "Experience", "SoftSkills",
        })
        self.assertEqual(set(shape["Languages"]), {"Applicant", "Job"})
        self.assertEqual(set(shape["Languages"]["Job"]), {"Mandatory", "Optional"})
        self.assertEqual(shape["HardSkills"]["score"], "number 0.0-10.0")

    def test_a_real_zero_score_is_valid(self):
        validate_result(valid_result())
        self.assertEqual(calculate_final_score(
            hard_skills_score=0, experience_score=0,
            soft_skills_score=0, language_disqualified=False,
        ), 0.0)

    def test_invalid_scores_do_not_get_clamped(self):
        for score in (11, -1, float('nan'), float('inf'), 'bad', True):
            with self.subTest(score=score), self.assertRaises(InvalidCompatibilityResult):
                validate_result(valid_result(score))

    def test_missing_sections_and_placeholders_fail(self):
        for field in ('Description', 'HardSkills', 'Experience', 'SoftSkills', 'Languages'):
            data = valid_result()
            del data[field]
            with self.subTest(field=field), self.assertRaises(InvalidCompatibilityResult):
                validate_result(data)
        data = valid_result()
        data['Description'] = '...'
        with self.assertRaises(InvalidCompatibilityResult):
            validate_result(data)
        data = valid_result()
        data['HardSkills']['description'] = '...'
        with self.assertRaises(InvalidCompatibilityResult):
            validate_result(data)
        with self.assertRaises(InvalidCompatibilityResult):
            validate_result({'__parse_error': 'json_loads_failed'})
        with self.assertRaises(InvalidCompatibilityResult):
            normalize_result({'__parse_error': 'json_loads_failed'})
        data = valid_result()
        data['Languages']['Job']['Mandatory'] = [{'Level': 'C1'}]
        with self.assertRaises(InvalidCompatibilityResult):
            validate_result(data)

    def test_insufficient_description_is_permanent(self):
        with self.assertRaises(InsufficientJobDescription):
            check_job_description({'title': 'Developer', 'description': 'Developer'})
        with self.assertRaises(InsufficientJobDescription):
            check_job_description({'description': '<p>Apply now!</p>'})
        with self.assertRaises(InsufficientJobDescription):
            validate_result({'status': 'insufficient_job_description'})

    def test_short_specific_description_is_allowed(self):
        check_job_description({'description': 'Build Python services using Azure and SQL.'})

    def test_content_failure_retries_exactly_once(self):
        attempts = []
        first = SimpleNamespace(raw={'__parse_error': 'bad'}, lease_token='token-1')
        def retry(token):
            attempts.append(token)
            return SimpleNamespace(raw=valid_result(), lease_token='token-2')
        result = validate_with_content_retry(first, retry=retry)
        self.assertTrue(result.retried)
        self.assertEqual(result.lease_token, 'token-2')
        self.assertEqual(attempts, ['token-1'])
        self.assertIsNone(result.error_code)

    def test_second_invalid_response_fails_without_a_zero(self):
        first = SimpleNamespace(raw=valid_result(), lease_token='token')
        first.raw['Description'] = '...'
        result = validate_with_content_retry(
            first,
            retry=lambda token: SimpleNamespace(raw={'__parse_error': 'bad'}, lease_token='new'),
        )
        self.assertEqual(result.error_code, 'INFERENCE_INVALID_RESULT')
        self.assertIsNone(result.raw)
        self.assertEqual(result.lease_token, 'new')

    def test_model_reports_insufficient_data_without_retry(self):
        def forbidden_retry(token):
            raise AssertionError('Must not retry permanent input failures')
        result = validate_with_content_retry(
            SimpleNamespace(raw={'status': 'insufficient_job_description'}, lease_token='token'),
            retry=forbidden_retry,
        )
        self.assertEqual(result.error_code, 'INSUFFICIENT_JOB_DESCRIPTION')

    def test_valid_response_does_not_retry(self):
        result = validate_with_content_retry(
            SimpleNamespace(raw=valid_result(), lease_token='token'),
            retry=lambda token: self.fail('Unexpected retry'),
        )
        self.assertFalse(result.retried)
