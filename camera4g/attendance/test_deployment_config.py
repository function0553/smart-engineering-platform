import unittest

from attendance_service import bind_address


class DeploymentConfigTests(unittest.TestCase):
    def test_bind_default_and_external_interface(self):
        self.assertEqual(bind_address({}), ('127.0.0.1', 28982))
        self.assertEqual(bind_address({'bind': {'host': '0.0.0.0', 'port': 28982}}), ('0.0.0.0', 28982))
        self.assertEqual(bind_address({'bind': {'host': '192.168.1.200', 'port': 28982}}), ('192.168.1.200', 28982))

    def test_invalid_listener_is_rejected_before_models_start(self):
        for host, port in [('gpu.example.com', 28982), ('::1', 28982), ('127.0.0.1', True),
                           ('127.0.0.1', '28982'), ('127.0.0.1', 80), ('127.0.0.1', 65536)]:
            with self.subTest(host=host, port=port), self.assertRaises(ValueError):
                bind_address({'bind': {'host': host, 'port': port}})


if __name__ == '__main__':
    unittest.main()
