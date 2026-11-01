class DomainError(Exception):
    def __init__(
        self,
        status,
        code,
        detail,
        *,
        current_revision_id=None,
        blockers=None,
        field_errors=None,
        headers=None,
    ):
        self.status = status
        self.code = code
        self.detail = detail
        self.current_revision_id = current_revision_id
        self.blockers = blockers or []
        self.field_errors = field_errors or []
        self.headers = headers or {}
        super().__init__(detail)


def gap(code, message, *inputs):
    return {"code": code, "message": message, "required_inputs": list(inputs), "blocking": True}
