"""A frozen method must reject accidental formula or parameter edits."""
import json
from pathlib import Path
import tempfile
import unittest

from method_lock import METHOD_PATH, ROOT, verify_method


class MethodLockTests(unittest.TestCase):
    def test_adopted_method_matches_actual_code_and_parameters(self):
        method = verify_method()
        self.assertEqual(method['verification'], 'passed')
        self.assertEqual(method['primary_model'], 'option_implied')
        self.assertEqual(method['model_roles']['option_calibrated'], 'experimental')

    def test_formula_and_parameter_edits_require_a_new_version(self):
        method = json.loads((ROOT / METHOD_PATH).read_text())
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / METHOD_PATH).parent.mkdir(parents=True)
            (root / METHOD_PATH).write_bytes((ROOT / METHOD_PATH).read_bytes())
            for artifact in method['locked_artifacts'].values():
                target = root / artifact['path']
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((ROOT / artifact['path']).read_bytes())
            self.assertEqual(verify_method(root)['verification'], 'passed')
            for label, artifact in method['locked_artifacts'].items():
                with self.subTest(artifact=label):
                    target = root / artifact['path']
                    original = target.read_bytes()
                    target.write_bytes(original + b'\nchanged\n')
                    with self.assertRaisesRegex(ValueError, 'Frozen range method mismatch'):
                        verify_method(root)
                    target.write_bytes(original)


if __name__ == '__main__':
    unittest.main()
