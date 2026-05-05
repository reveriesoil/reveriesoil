from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    # SQLite 数据库路径（相对于运行目录）
    database_url: str = "sqlite+aiosqlite:///./dreamit.db"

    # 静态资源目录（生成图片保存路径）
    static_dir: str = "./static"

    # 前端地址（CORS）
    frontend_url: str = "http://localhost:3000"

    # CORS 白名单（逗号分隔；留空则回退到 frontend_url）
    cors_allow_origins: str = ""

    # 后端公网地址（用于图片 URL 拼接，留空则自动使用请求 host）
    api_base_url: str = ""

    # 服务监听端口（桌面版通过 PORT 环境变量传入）
    port: int = 59876


settings = Settings()
