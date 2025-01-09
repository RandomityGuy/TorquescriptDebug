import {
    IASTVisitor,
    expr_AssignExpr,
    expr_AssignOpExpr,
    expr_BinaryExpr,
    expr_BreakStmt,
    expr_CommaCatExpr,
    expr_ConditionalExpr,
    expr_ConstantExpr,
    expr_ContinueStmt,
    expr_Expr,
    expr_FloatBinaryExpr,
    expr_FloatExpr,
    expr_FloatUnaryExpr,
    expr_FuncCallExpr,
    expr_FunctionDeclStmt,
    expr_IfStmt,
    expr_IntBinaryExpr,
    expr_IntExpr,
    expr_IntUnaryExpr,
    expr_LoopStmt,
    expr_ObjectDeclExpr,
    expr_ParenthesisExpr,
    expr_ReturnStmt,
    expr_SlotAccessExpr,
    expr_SlotAssignExpr,
    expr_SlotAssignOpExpr,
    expr_Stmt,
    expr_StrCatExpr,
    expr_StrEqExpr,
    expr_StringConstExpr,
    expr_VarExpr,
    expr_AssertStmt,
    expr_InternalNameAccessExpr,
    expr_IterStmt,
} from "./hxTorquescript";

export class VarListener implements IASTVisitor {
    localVariables: Map<string, Set<string>> = new Map();
    globalVariables: Set<string> = new Set();

    currentFn: string = "";

    constructor() {}

    visitAssertStmt(stmt: expr_AssertStmt): void {}
    visitIterStmt(stmt: expr_IterStmt): void {}
    visitInternalNameAccessExpr(expr: expr_InternalNameAccessExpr): void {}
    visitStmt(stmt: expr_Stmt): void {}
    visitBreakStmt(stmt: expr_BreakStmt): void {}
    visitContinueStmt(stmt: expr_ContinueStmt): void {}
    visitExpr(expr: expr_Expr): void {}
    visitParenthesisExpr(expr: expr_ParenthesisExpr): void {}
    visitReturnStmt(stmt: expr_ReturnStmt): void {}
    visitIfStmt(stmt: expr_IfStmt): void {}
    visitLoopStmt(stmt: expr_LoopStmt): void {}
    visitBinaryExpr(expr: expr_BinaryExpr): void {}
    visitFloatBinaryExpr(expr: expr_FloatBinaryExpr): void {}
    visitIntBinaryExpr(expr: expr_IntBinaryExpr): void {}
    visitStrEqExpr(expr: expr_StrEqExpr): void {}
    visitStrCatExpr(expr: expr_StrCatExpr): void {}
    visitCommatCatExpr(expr: expr_CommaCatExpr): void {}
    visitConditionalExpr(expr: expr_ConditionalExpr): void {}
    visitIntUnaryExpr(expr: expr_IntUnaryExpr): void {}
    visitFloatUnaryExpr(expr: expr_FloatUnaryExpr): void {}
    visitVarExpr(expr: expr_VarExpr): void {
        const varType = expr.type.toString();
        if (varType === "Local") {
            if (!this.localVariables.has(this.currentFn)) {
                this.localVariables.set(this.currentFn, new Set());
            }
            this.localVariables.get(this.currentFn)!.add("%" + expr.name.lexeme);
        }
        if (varType === "Global") {
            this.globalVariables.add("$" + expr.name.lexeme);
        }
    }
    visitIntExpr(expr: expr_IntExpr): void {}
    visitFloatExpr(expr: expr_FloatExpr): void {}
    visitStringConstExpr(expr: expr_StringConstExpr): void {}
    visitConstantExpr(expr: expr_ConstantExpr): void {}
    visitAssignExpr(expr: expr_AssignExpr): void {}
    visitAssignOpExpr(expr: expr_AssignOpExpr): void {}
    visitFuncCallExpr(expr: expr_FuncCallExpr): void {}
    visitSlotAccessExpr(expr: expr_SlotAccessExpr): void {}
    visitSlotAssignExpr(expr: expr_SlotAssignExpr): void {}
    visitSlotAssignOpExpr(expr: expr_SlotAssignOpExpr): void {}
    visitObjectDeclExpr(expr: expr_ObjectDeclExpr): void {}
    visitFunctionDeclStmt(stmt: expr_FunctionDeclStmt): void {
        let fnName = "";
        if (stmt.namespace !== null) {
            fnName = stmt.namespace.lexeme + "::" + stmt.functionName.lexeme;
        } else {
            fnName = stmt.functionName.lexeme;
        }
        if (stmt.packageName) {
            fnName = stmt.packageName.lexeme + "::" + fnName;
        }
        this.currentFn = fnName.toLowerCase();
    }
}
