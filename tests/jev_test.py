import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts/connection'))
import jev


class Response(io.BytesIO):
    status = 200


class Opener:
    def __init__(self, fail=False):
        self.fail = fail
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        if self.fail:
            raise urllib.error.HTTPError(request.full_url, 401, 'PRIVATE ERROR', {}, io.BytesIO(b'SECRET'))
        return Response(b'{"models":[]}')


class JevConfigurationTests(unittest.TestCase):
    models = {'routine': 'fixture-light', 'standard': 'fixture-standard', 'complex': 'fixture-complex'}

    def test_verified_key_is_private_and_result_contains_no_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'jev.json'
            opener = Opener()
            result = jev.configure(path, 'PRIVATE-FIXTURE-KEY', self.models, opener=opener)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(path.read_text())['apiKey'], 'PRIVATE-FIXTURE-KEY')
            self.assertNotIn('PRIVATE-FIXTURE-KEY', json.dumps(result))
            self.assertEqual(opener.requests[0].full_url, 'https://api.typesafe.ai/v1/models')
            self.assertEqual(opener.requests[0].get_method(), 'GET')
            self.assertTrue(result['accessVerified'])

    def test_rejected_key_preserves_existing_config_and_suppresses_error_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'jev.json'
            path.write_text('{"mode":"off"}')
            with self.assertRaisesRegex(RuntimeError, '^TypeSafe access check returned HTTP 401; no settings were changed.$'):
                jev.configure(path, 'PRIVATE-FIXTURE-KEY', self.models, opener=Opener(fail=True))
            self.assertEqual(path.read_text(), '{"mode":"off"}')

    def test_setup_preserves_existing_limits_and_refuses_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'jev.json'
            path.write_text('{"mode":"off","maxCallsPerHour":10}')
            jev.configure(path, 'PRIVATE-FIXTURE-KEY', self.models, opener=Opener())
            self.assertEqual(json.loads(path.read_text())['maxCallsPerHour'], 10)
            link = Path(directory) / 'link.json'
            link.symlink_to(path)
            with self.assertRaises(RuntimeError):
                jev.configure(link, 'PRIVATE-FIXTURE-KEY', self.models, opener=Opener())


if __name__ == '__main__':
    unittest.main()
