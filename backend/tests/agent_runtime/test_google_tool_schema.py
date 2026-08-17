from pydantic import BaseModel, Field

from app.agent_runtime.graph.react_agent import _google_tool_definition
from app.agent_runtime.tools.base import AgentTool
from app.agent_runtime.tools import ToolRegistry
from app.agent_runtime.tools.impls.chapter.refs import ChapterRef


class WriteChapterSchema(BaseModel):
    chapter_ref: ChapterRef | None = Field(default=None, description="章节引用")


class StubTool(AgentTool):
    name: str = "write_chapter"
    description: str = "创建一个新章节"
    args_schema: type[BaseModel] = WriteChapterSchema

    async def _execute(self, **kwargs):
        return "ok"


def test_google_tool_definition_inlines_nested_refs():
    definition = _google_tool_definition(StubTool())
    parameters = definition["parameters"]

    assert parameters["type"] == "object"
    assert "$defs" not in parameters
    assert "$ref" not in str(parameters)
    chapter_ref = parameters["properties"]["chapter_ref"]
    assert chapter_ref["type"] == "object"
    assert chapter_ref["nullable"] is True
    assert "anyOf" not in chapter_ref


def test_google_tool_definitions_have_explicit_types_without_refs_or_unions():
    tools = ToolRegistry.get_tools(state={"project_id": "project", "session_id": "session"})

    for tool in tools:
        parameters = _google_tool_definition(tool)["parameters"]
        assert parameters.get("type") == "object", tool.name
        serialized = str(parameters)
        assert "$ref" not in serialized, tool.name
        assert "anyOf" not in serialized, tool.name
