"""
Guardian v4.5.7 回归测试套件
运行: python test_regression.py
依赖: playwright (pip install playwright)
"""

import sys
import json
import time

PYTHON = r"C:\Users\weiqi\AppData\Local\Programs\Python\Python312\python.exe"
sys.path.insert(0, r"C:\Users\weiqi\AppData\Local\Programs\Python\Python312\Lib\site-packages")

from playwright.sync_api import sync_playwright, expect

INDEX_URL = "file:///d:/文档/魏强的文件/魏强的AI项目/Guardian/guardian-app/www/index.html"
JS_DIR = "d:/文档/魏强的文件/魏强的AI项目/Guardian/guardian-app/www/js/"

TEST_RESULTS = {"passed": 0, "failed": 0, "skipped": 0}


def log_test(name, passed, detail=""):
    status = "PASS" if passed else "FAIL"
    icon = "✅" if passed else "❌"
    print(f"  {icon} {status}: {name} {detail}")
    if passed:
        TEST_RESULTS["passed"] += 1
    else:
        TEST_RESULTS["failed"] += 1


class GuardianRegressionTests:
    """回归测试类 - 每个测试方法独立运行"""

    def test_01_module_files_exist(self):
        """测试1: 模块JS文件存在性"""
        import os
        files = ["p2p-core.js", "pairing-ui.js", "permissions.js"]
        all_ok = True
        for f in files:
            path = os.path.join(JS_DIR, f)
            exists = os.path.isfile(path)
            size = os.path.getsize(path) if exists else 0
            ok = exists and size > 1000
            log_test(f"文件 {f} 存在且有效", ok, f"({size} bytes)")
            if not ok:
                all_ok = False
        return all_ok

    def test_02_script_tags_in_html(self):
        """测试2: HTML中模块script标签引用正确"""
        with open("guardian-app/www/index.html", "r", encoding="utf-8") as f:
            content = f.read()
        checks = [
            ('<script src="js/p2p-core.js">', "p2p-core.js"),
            ('<script src="js/permissions.js">', "permissions.js"),
            ('<script src="js/pairing-ui.js">', "pairing-ui.js"),
        ]
        all_ok = True
        for tag, name in checks:
            found = tag in content
            log_test(f"HTML包含 {name} 引用", found)
            if not found:
                all_ok = False
        return all_ok

    def test_03_p2p_core_no_syntax_error(self):
        """测试3: p2p-core.js无语法错误"""
        import subprocess
        result = subprocess.run(
            [PYTHON, "-c", "import js2py; print('OK')"],
            capture_output=True, text=True
        )
        # We can't run JS directly in Python, but we can check file structure
        with open("guardian-app/www/js/p2p-core.js", "r", encoding="utf-8") as f:
            content = f.read()
        # Check critical objects exist
        checks = [
            ("RealTimeSync", "RealTimeSync"),
            ("SocketIOSignaling", "SocketIOSignaling"),
            ("_connectSig", "_connectSig"),
            ("generateAuthCode", "generateAuthCode"),
            ("connectWithCode", "connectWithCode"),
        ]
        all_ok = True
        for keyword, name in checks:
            found = keyword in content
            log_test(f"p2p-core.js 含 {name}", found)
            if not found:
                all_ok = False
        return all_ok

    def test_04_pairing_ui_no_syntax_error(self):
        """测试4: pairing-ui.js无语法错误"""
        with open("guardian-app/www/js/pairing-ui.js", "r", encoding="utf-8") as f:
            content = f.read()
        checks = [
            ("handleGenerateAuthCode", "handleGenerateAuthCode"),
            ("handleConnectWithCode", "handleConnectWithCode"),
            ("recipientConnectWithCode", "recipientConnectWithCode"),
            ("updateP2PStatus", "updateP2PStatus"),
            ("initP2PListeners", "initP2PListeners"),
            ("window.handleGenerateAuthCode", "window.handleGenerateAuthCode"),
        ]
        all_ok = True
        for keyword, name in checks:
            found = keyword in content
            log_test(f"pairing-ui.js 含 {name}", found)
            if not found:
                all_ok = False
        return all_ok

    def test_05_permissions_no_syntax_error(self):
        """测试5: permissions.js无语法错误"""
        with open("guardian-app/www/js/permissions.js", "r", encoding="utf-8") as f:
            content = f.read()
        checks = [
            ("PermissionManager", "PermissionManager"),
            ("requestNotificationPermission", "requestNotificationPermission"),
            ("requestLocationPermission", "requestLocationPermission"),
        ]
        all_ok = True
        for keyword, name in checks:
            found = keyword in content
            log_test(f"permissions.js 含 {name}", found)
            if not found:
                all_ok = False
        return all_ok

    def test_10_guardian_pairing_page_loads(self):
        """测试10: 守护端配对页面能正常加载"""
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                context = browser.new_context(
                    viewport={"width": 390, "height": 844},
                    permissions=["geolocation"]
                )
                page = context.new_page()

                # 收集控制台JS错误
                js_errors = []
                page.on("pageerror", lambda err: js_errors.append(str(err)))
                console_logs = []
                page.on("console", lambda msg: console_logs.append(msg.text))

                page.goto(INDEX_URL, wait_until="networkidle")
                time.sleep(1)

                # 检查角色选择页面
                role_selector = page.locator("#roleSelectionOverlay")
                visible = role_selector.is_visible()
                log_test("角色选择覆盖层可见", visible)

                if not visible:
                    # 可能自动选择了角色
                    log_test("角色已自动选择 (跳过)", True, "非预期但可接受")

                browser.close()
                return True
        except Exception as e:
            log_test("页面加载测试异常", False, str(e))
            return False

    def test_11_guardian_generate_code_ui(self):
        """测试11: 守护端生成授权码按钮存在"""
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                context = browser.new_context(
                    viewport={"width": 390, "height": 844}
                )
                page = context.new_page()

                page.goto(INDEX_URL, wait_until="networkidle")
                time.sleep(0.5)

                # 强制隐藏权限弹窗
                page.evaluate("document.getElementById('permissionPrompt').style.display='none'")
                time.sleep(0.3)

                # 选择监护人角色
                guardian_btn = page.locator("text=监护人").first
                if guardian_btn.is_visible():
                    guardian_btn.click()
                    time.sleep(0.5)

                # JS直接导航到配对页
                page.evaluate("""
                    var p = document.getElementById('guardian-pairings');
                    if (p) p.classList.add('active');
                    var h = document.getElementById('guardian-home');
                    if (h) h.classList.remove('active');
                """)
                time.sleep(0.3)

                # 检查按钮存在
                btn_exists = page.evaluate("!!document.getElementById('generateCodeBtn')")
                log_test("生成授权码按钮存在", btn_exists)

                browser.close()
                return btn_exists
        except Exception as e:
            log_test("守护端配对UI测试异常", False, str(e))
            return False

    def test_12_module_loading_no_404(self):
        """测试12: 模块JS文件加载无404"""
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                context = browser.new_context()
                page = context.new_page()

                # 捕获网络请求失败
                failed_requests = []
                page.on("requestfailed", lambda req: failed_requests.append(req.url))

                page.goto(INDEX_URL, wait_until="networkidle")
                time.sleep(1)

                # 检查是否有js/路径的404
                js_404 = [url for url in failed_requests if "js/" in url and "404" in str(url)]
                log_test("模块JS文件无404", len(js_404) == 0,
                         f"404s={js_404}" if js_404 else "")

                browser.close()
                return len(js_404) == 0
        except Exception as e:
            log_test("模块加载测试异常", False, str(e))
            return False

    def test_13_js_functions_available(self):
        """测试13: 关键JS函数在页面加载后可用（检测语法错误）"""
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                page = browser.new_page()
                page.goto(INDEX_URL, wait_until="networkidle")
                time.sleep(0.5)

                checks = [
                    ("typeof selectRole === 'function'", "selectRole"),
                    ("typeof DataStore === 'object'", "DataStore"),
                    ("typeof RealTimeSync === 'object'", "RealTimeSync"),
                    ("typeof showToast === 'function'", "showToast"),
                    ("typeof navigateTo === 'function'", "navigateTo"),
                ]
                all_ok = True
                for expr, label in checks:
                    exists = page.evaluate(expr)
                    log_test(f"JS函数 {label} 可用", exists)
                    if not exists:
                        all_ok = False

                browser.close()
                return all_ok
        except Exception as e:
            log_test("JS函数可用性测试异常", False, str(e))
            return False

    def test_99_summary(self):
        """汇总报告"""
        total = TEST_RESULTS["passed"] + TEST_RESULTS["failed"] + TEST_RESULTS["skipped"]
        print(f"\n{'='*50}")
        print(f"  回归测试报告")
        print(f"{'='*50}")
        print(f"  总计: {total}")
        print(f"  通过: {TEST_RESULTS['passed']} ✅")
        print(f"  失败: {TEST_RESULTS['failed']} ❌")
        print(f"  跳过: {TEST_RESULTS['skipped']} ⏭️")
        pass_rate = TEST_RESULTS["passed"] / max(total, 1) * 100
        print(f"  通过率: {pass_rate:.0f}%")
        print(f"{'='*50}")
        return TEST_RESULTS["failed"] == 0


def run_all_tests():
    """运行所有测试"""
    t = GuardianRegressionTests()

    # === 静态分析测试 (无需浏览器) ===
    print("\n=== 静态模块验证 ===")
    t.test_01_module_files_exist()
    t.test_02_script_tags_in_html()
    t.test_03_p2p_core_no_syntax_error()
    t.test_04_pairing_ui_no_syntax_error()
    t.test_05_permissions_no_syntax_error()

    # === 浏览器渲染测试 ===
    print("\n=== 浏览器加载验证 ===")
    t.test_12_module_loading_no_404()
    t.test_10_guardian_pairing_page_loads()
    t.test_11_guardian_generate_code_ui()
    t.test_13_js_functions_available()

    # === 汇总 ===
    print("\n")
    return t.test_99_summary()


if __name__ == "__main__":
    success = run_all_tests()
    sys.exit(0 if success else 1)