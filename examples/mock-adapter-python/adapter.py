"""Minimal cross-language Adapter foundation for Runtime contract tests."""

from __future__ import annotations

import asyncio
import logging
import os

import grpc
from google.protobuf.json_format import ParseDict
from google.protobuf.struct_pb2 import Struct

from generated import adapter_pb2, adapter_pb2_grpc


def json_struct(value: dict) -> Struct:
    message = Struct()
    ParseDict(value, message)
    return message


class ReferenceAdapter(adapter_pb2_grpc.ResourceProviderAdapterServicer):
    async def DescribeProvider(self, request, context):  # noqa: N802
        del request, context
        operation = adapter_pb2.OperationDefinition(
            name="python_echo_sync",
            description="Python reference synchronous echo operation.",
            execution=adapter_pb2.SYNCHRONOUS,
            input_schema=json_struct(
                {
                    "type": "object",
                    "properties": {"message": {"type": "string"}},
                    "required": ["message"],
                    "additionalProperties": False,
                }
            ),
            output_schema=json_struct({"type": "object"}),
            capabilities=adapter_pb2.OperationCapabilities(
                availability=True,
                idempotency=True,
            ),
            resource_binding=adapter_pb2.ResourceBinding(mode=adapter_pb2.ResourceBinding.NONE),
        )
        return adapter_pb2.ProviderManifest(
            adapter_protocol_version="1.0",
            provider_id=os.getenv("PROVIDER_ID", "mock-provider-python"),
            provider_type="reference",
            provider_version="1.0.0",
            inventory_mode=adapter_pb2.RUNTIME_VISIBLE,
            operations=[operation],
        )

    async def GetExecution(self, request, context):  # noqa: N802
        await context.abort(grpc.StatusCode.NOT_FOUND, f"Execution {request.task_id} does not exist")


async def serve() -> None:
    host = os.getenv("ADAPTER_HOST", "0.0.0.0")
    port = int(os.getenv("ADAPTER_PORT", "7001"))
    server = grpc.aio.server()
    adapter_pb2_grpc.add_ResourceProviderAdapterServicer_to_server(ReferenceAdapter(), server)
    server.add_insecure_port(f"{host}:{port}")
    await server.start()
    logging.info("Python mock Adapter listening on %s:%d", host, port)
    await server.wait_for_termination()


if __name__ == "__main__":
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
    asyncio.run(serve())
