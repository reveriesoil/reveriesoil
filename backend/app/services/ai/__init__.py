class AccountOverdueError(Exception):
    """API 账户欠费/余额不足，请充值后重试。"""
