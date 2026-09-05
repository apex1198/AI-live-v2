import ast
import pathlib
import unittest


SERVER_PATH = pathlib.Path(__file__).with_name('server.py')


class QwenReadyStartupTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = SERVER_PATH.read_text(encoding='utf-8')
        cls.tree = ast.parse(cls.source)

    def test_startup_loads_the_model_before_exposing_http_service(self):
        main = next(node for node in self.tree.body if isinstance(node, ast.FunctionDef) and node.name == 'main')
        eager_loads = [
            node for node in ast.walk(main)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == 'load'
        ]
        self.assertEqual(len(eager_loads), 1)
        self.assertEqual(ast.unparse(eager_loads[0]), 'engine.load()')

    def test_synthesis_keeps_a_ready_model_before_generation(self):
        engine = next(node for node in self.tree.body if isinstance(node, ast.ClassDef) and node.name == 'Engine')
        synthesize = next(node for node in engine.body if isinstance(node, ast.FunctionDef) and node.name == 'synthesize')
        first_statement = synthesize.body[0]
        self.assertIsInstance(first_statement, ast.Expr)
        self.assertEqual(ast.unparse(first_statement), 'self.load()')

    def test_health_reports_model_readiness(self):
        self.assertIn('"ready": engine.model is not None', self.source)
        self.assertIn('"model_loaded": engine.model is not None', self.source)


if __name__ == '__main__':
    unittest.main()
