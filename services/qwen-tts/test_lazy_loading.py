import ast
import pathlib
import unittest


SERVER_PATH = pathlib.Path(__file__).with_name('server.py')


class QwenLazyLoadingTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = SERVER_PATH.read_text(encoding='utf-8')
        cls.tree = ast.parse(cls.source)

    def test_startup_does_not_load_the_model(self):
        main = next(node for node in self.tree.body if isinstance(node, ast.FunctionDef) and node.name == 'main')
        eager_loads = [
            node for node in ast.walk(main)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == 'load'
        ]
        self.assertEqual(eager_loads, [])

    def test_synthesis_loads_model_on_first_use(self):
        engine = next(node for node in self.tree.body if isinstance(node, ast.ClassDef) and node.name == 'Engine')
        synthesize = next(node for node in engine.body if isinstance(node, ast.FunctionDef) and node.name == 'synthesize')
        first_statement = synthesize.body[0]
        self.assertIsInstance(first_statement, ast.Expr)
        self.assertEqual(ast.unparse(first_statement), 'self.load()')

    def test_health_distinguishes_service_ready_from_model_loaded(self):
        self.assertIn('"ready": True', self.source)
        self.assertIn('"model_loaded": engine.model is not None', self.source)


if __name__ == '__main__':
    unittest.main()
