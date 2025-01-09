import {
    Logger,
    logger,
    LoggingDebugSession,
    InitializedEvent,
    TerminatedEvent,
    StoppedEvent,
    BreakpointEvent,
    OutputEvent,
    Thread,
    StackFrame,
    Scope,
    Source,
    Breakpoint,
    ContinuedEvent,
    Variable,
} from "@vscode/debugadapter";
import { DebugProtocol } from "@vscode/debugprotocol";
import { basename } from "path-browserify";
import { Subject } from "await-notify";
import * as net from "net";
import * as vscode from "vscode";
import * as fs from "fs";
import path = require("path");
import { VarListener } from "./tscript/VarListener";
import { Parser, Scanner } from "./tscript/hxTorquescript";

interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    /** The IP address of the target to attach to. */
    address: string;
    /** The port of the target to attach to. */
    port: number;
    /** An optional password for the target. */
    password?: string;
    trace?: boolean;
    /** Root directory */
    rootDir?: string;
}

interface IAttachRequestArguments extends ILaunchRequestArguments {}

interface TSBreakpointLoc {
    line: number;
    breakpointId: number;
    condition?: string;
    hitCondition?: string;
}

interface TSStackFrame {
    file: string;
    function: string;
    line: number;
}

enum TSVariableScope {
    Local = 1,
    Global = 2,
}

export class TSDebugSession extends LoggingDebugSession {
    // we don't support multiple threads, so we can use a hardcoded ID for the default thread
    private static threadID = 1;

    private _configurationDone = new Subject();

    private socket: net.Socket | undefined;
    rawReceivedData: string = "";
    rootDir: string | undefined;

    breakpointLocations: Map<string, TSBreakpointLoc[]> = new Map();
    stackFrames: TSStackFrame[] = [];
    actualStackFrames: DebugProtocol.StackFrame[] = [];
    stackStart: number = 0;

    tryPause: boolean = false;

    bpId: number = 0;
    varReqId: number = 0;
    varReqPromResolves: Map<number, (val: string | null) => void> = new Map();

    parsedAsts: Map<string, VarListener> = new Map(); // Filepath -> Listener

    /**
     * Creates a new debug adapter that is used for one debug session.
     * We configure the default implementation of a debug adapter here.
     */
    public constructor() {
        super("ts-debug.txt");

        // this debugger uses zero-based lines and columns
        this.setDebuggerLinesStartAt1(true);
        this.setDebuggerColumnsStartAt1(true);
    }

    /**
     * The 'initialize' request is the first request called by the frontend
     * to interrogate the features the debug adapter provides.
     */
    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
        // build and return the capabilities of this debug adapter:
        response.body = response.body || {};

        // the adapter implements the configurationDone request.
        response.body.supportsConfigurationDoneRequest = true;

        // make VS Code use 'evaluate' when hovering over source
        response.body.supportsEvaluateForHovers = true;

        // make VS Code show a 'step back' button
        response.body.supportsStepBack = false;

        // make VS Code support data breakpoints
        response.body.supportsDataBreakpoints = false;

        // make VS Code support completion in REPL
        response.body.supportsCompletionsRequest = false;

        // make VS Code send cancel request
        response.body.supportsCancelRequest = false;

        // make VS Code send the breakpointLocations request
        response.body.supportsBreakpointLocationsRequest = false;

        // make VS Code provide "Step in Target" functionality
        response.body.supportsStepInTargetsRequest = false;

        // the adapter defines two exceptions filters, one with support for conditions.
        response.body.supportsConditionalBreakpoints = true;
        response.body.supportsHitConditionalBreakpoints = true;
        response.body.supportsExceptionFilterOptions = false;
        response.body.exceptionBreakpointFilters = [];

        // make VS Code send exceptionInfo request
        response.body.supportsExceptionInfoRequest = false;

        // make VS Code send setVariable request
        response.body.supportsSetVariable = true;

        // make VS Code send setExpression request
        response.body.supportsSetExpression = false;

        // make VS Code send disassemble request
        response.body.supportsDisassembleRequest = false;
        response.body.supportsSteppingGranularity = false;
        response.body.supportsInstructionBreakpoints = false;

        // make VS Code able to read and write variable memory
        response.body.supportsReadMemoryRequest = false;
        response.body.supportsWriteMemoryRequest = false;

        response.body.supportSuspendDebuggee = false;
        response.body.supportTerminateDebuggee = false;
        response.body.supportsFunctionBreakpoints = false;
        response.body.supportsDelayedStackTraceLoading = false;

        this.sendResponse(response);

        // since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
        // we request them early by sending an 'initializeRequest' to the frontend.
        // The frontend will end the configuration sequence by calling 'configurationDone' request.
        this.sendEvent(new InitializedEvent());
    }

    /**
     * Called at the end of the configuration sequence.
     * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
     */
    protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
        super.configurationDoneRequest(response, args);

        // notify the launchRequest that configuration has finished
        this._configurationDone.notify();
    }

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void {
        console.log(`disconnectRequest suspend: ${args.suspendDebuggee}, terminate: ${args.terminateDebuggee}`);
        this.socket?.destroy();
    }

    protected async attachRequest(response: DebugProtocol.AttachResponse, args: IAttachRequestArguments) {
        return this.launchRequest(response, args);
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {
        // make sure to 'Stop' the buffered logging if 'trace' is not set
        logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

        this.rootDir = args.rootDir;

        // wait 1 second until configuration has finished (and configurationDoneRequest has been called)
        await this._configurationDone.wait(1000);

        let authenticated = false;

        this.socket = net.createConnection(args.port, args.address);

        this.socket.on("data", (data) => {
            console.log(data.toString());
        });

        let prom = new Promise<void>((resolve, reject) => {
            this.socket?.on("data", (data) => {
                if (authenticated) {
                    this.parseData(data);
                } else {
                    const str = data.toString();
                    const split = str.split(" ");
                    if (split.length > 1) {
                        const cmd = split[0];
                        if (cmd === "PASS") {
                            if (split[1] === "WrongPassword") {
                                reject("Wrong Password");
                            } else {
                                authenticated = true;
                                this.addStartingBreakpoints(); // Add starting breakpoints
                                resolve();
                            }
                        }
                    }
                }
            });
            this.socket?.on("connect", () => {
                // Send password
                let sent = this.socket?.write(args.password + "\n");
                console.log(`Sent ${sent} bytes`);
            });
            this.socket?.on("end", () => {
                this.sendEvent(new TerminatedEvent());
            });
            this.socket?.on("error", () => {
                reject("Timeout");
            });
        });

        await prom
            .then(() => {
                this.sendResponse(response);
            })
            .catch((err) => {
                this.sendErrorResponse(response, {
                    id: 1001,
                    format: err,
                    showUser: true,
                });
            });

        // Send a CONTINUE if we are paused
        this.socket?.write("CONTINUE\n");
    }

    protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
        let filePath = args.source.path as string;
        // The path is full path, it needs to be a relative path from current workspace
        let workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
        if (workspaceFolder) {
            filePath = vscode.workspace.asRelativePath(filePath, false);
        }
        if (this.rootDir && this.rootDir !== "") {
            // Change filepath to be relative to rootDir
            filePath = path.relative(this.rootDir, filePath);
            // Normalize slashes
            filePath = filePath.replace(/\\/g, "/");
        }

        // Clear all breakpoints for this file
        if (this.breakpointLocations.has(filePath)) {
            for (const brk of this.breakpointLocations.get(filePath) || []) {
                this.socket?.write(`BRKCLR ${filePath} ${brk.line}\n`);
            }
            this.breakpointLocations.delete(filePath);
        }

        // Set breakpoints
        let actualBreakpoints: TSBreakpointLoc[] = [];
        for (const brk of args.breakpoints || []) {
            this.socket?.write(
                `BRKSET ${filePath} ${brk.line} false ${brk.hitCondition ? parseInt(brk.hitCondition) : 0} ${brk.condition ? brk.condition : "true"}\n`
            );
            actualBreakpoints.push({ line: brk.line, breakpointId: this.bpId++, condition: brk.condition, hitCondition: brk.hitCondition });
        }
        this.breakpointLocations.set(filePath, actualBreakpoints);

        // notify the frontend that the breakpoints have been set
        const breakpoints = actualBreakpoints.map((brk) => {
            const bp = new Breakpoint(true, brk.line) as DebugProtocol.Breakpoint;
            bp.id = brk.breakpointId;
            return bp;
        });

        response.body = {
            breakpoints: breakpoints,
        };

        this.sendResponse(response);
    }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        // runtime supports no threads so just return a default thread.
        response.body = {
            threads: [new Thread(TSDebugSession.threadID, "Torquescript")],
        };
        this.sendResponse(response);
    }

    protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
        const startFrame = typeof args.startFrame === "number" ? args.startFrame : 0;
        const maxLevels = typeof args.levels === "number" ? args.levels : 1000;
        const endFrame = startFrame + maxLevels;
        const stk = this.stackFrames.slice(startFrame, endFrame);
        response.body = {
            stackFrames: stk.map((f, ix) => {
                const sf: DebugProtocol.StackFrame = new StackFrame(ix, f.function, this.createSource(f.file), this.convertDebuggerLineToClient(f.line));
                return sf;
            }),
            totalFrames: stk.length,
        };
        this.stackStart = startFrame;
        this.actualStackFrames = response.body.stackFrames;
        this.sendResponse(response);
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
        const stk = this.actualStackFrames[args.frameId]; // Frame id is the index

        const localScope = new Scope("Locals", args.frameId * 10 + TSVariableScope.Local, false) as DebugProtocol.Scope;
        const globalScope = new Scope("Globals", args.frameId * 10 + TSVariableScope.Global, true) as DebugProtocol.Scope;

        localScope.source = stk.source;
        globalScope.source = stk.source;

        localScope.presentationHint = "locals";

        response.body = {
            scopes: [localScope, globalScope],
        };
        this.sendResponse(response);
    }

    protected async variablesRequest(
        response: DebugProtocol.VariablesResponse,
        args: DebugProtocol.VariablesArguments,
        request?: DebugProtocol.Request
    ): Promise<void> {
        const varType = (args.variablesReference % 10) as TSVariableScope;
        const stkId = Math.floor(args.variablesReference / 10);

        const stkFrame = this.actualStackFrames[stkId];

        const scopeVars = [] as DebugProtocol.Variable[];

        // Check if we can open the source and read it
        if (stkFrame.source?.path && stkFrame.source.path !== "" && fs.existsSync(stkFrame.source.path)) {
            const file = stkFrame.source.path;

            if (!this.parsedAsts.has(file)) {
                // Parse it!
                try {
                    const chars = fs.readFileSync(file).toString();
                    const lexer = new Scanner(chars);
                    const tokens = lexer.scanTokens();
                    const parser = new Parser(tokens);
                    const stmts = parser.parse();
                    const varListener = new VarListener();
                    for (const stmt of stmts) {
                        stmt.visitStmt(varListener);
                    }
                    this.parsedAsts.set(file, varListener);
                } catch (e) {
                    console.error(e);
                }
            }

            const varListener = this.parsedAsts.get(file);
            if (varListener) {
                let varList: string[] = [];
                switch (varType) {
                    case TSVariableScope.Global:
                        varList = [...varListener.globalVariables];
                        break;

                    case TSVariableScope.Local:
                        varList = [...(varListener.localVariables.get(stkFrame.name.toLowerCase()) as Set<string>)];
                        break;
                }

                const proms = varList.map((v) => this.requestVariable(v, stkId + this.stackStart));
                const results = await Promise.all(proms);
                for (let i = 0; i < varList.length; i++) {
                    let vval = results[i];
                    if (vval === null) {
                        vval = "Failed to fetch!";
                    }
                    if (vval === '""') {
                        // These are empty variables, no need to show them
                        continue;
                    }
                    const sv = new Variable(varList[i], vval) as DebugProtocol.Variable;
                    scopeVars.push(sv);
                }
            }
        }
        response.body = {
            variables: scopeVars,
        };
        this.sendResponse(response);
    }

    protected async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments) {
        const varType = (args.variablesReference % 10) as TSVariableScope;
        const stkId = Math.floor(args.variablesReference / 10);

        this.socket?.write(`EVAL 0 ${stkId + this.stackStart} ${args.name}=${args.value}\n`);
        let newValue = await this.requestVariable(args.name, stkId + this.stackStart);
        if (newValue === null) {
            newValue = "Failed to fetch!";
        }
        response.body = {
            value: newValue,
        };
        this.sendResponse(response);
    }

    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
        this.socket?.write("CONTINUE\n");
        this.sendResponse(response);
    }

    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
        this.socket?.write("STEPOVER\n");
        this.sendResponse(response);
    }

    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
        this.socket?.write("STEPIN\n");
        this.sendResponse(response);
    }

    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
        this.socket?.write("STEPOUT\n");
        this.sendResponse(response);
    }

    protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
        this.socket?.write("STEPIN\n");
        this.sendResponse(response);
        this.tryPause = true;
    }

    protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
        const stkId = this.stackStart + (args.frameId || 0);
        switch (args.context) {
            case "repl": {
                this.socket?.write(`CEVAL ${args.expression}\n`);
                break;
            }
            case "watch": {
                let res = await this.requestVariable(args.expression, stkId);
                if (res !== null) {
                    response.success = true;
                    response.body = {
                        result: res,
                        variablesReference: 0,
                    };
                } else {
                    response.success = false;
                    response.message = "Failed to evaluate!";
                }
                break;
            }
            case "hover": {
                let res = await this.requestVariable(args.expression, stkId);
                if (res !== null) {
                    response.success = true;
                    response.body = {
                        result: res,
                        variablesReference: 0,
                    };
                }
                break;
            }
        }
        this.sendResponse(response);
    }

    async requestVariable(name: string, frame: number) {
        const tag = this.varReqId++;
        let resolved = false;
        const prom = new Promise<string | null>((resolve, _) => {
            this.varReqPromResolves.set(tag, (res) => {
                resolved = true;
                resolve(res);
            });
            this.socket?.write(`EVAL ${tag} ${frame} ${name}\n`);
        });
        setTimeout(() => {
            if (!resolved) {
                // Timeout
                const fn = this.varReqPromResolves.get(tag);
                if (fn) {
                    fn(null);
                }
            }
        }, 2000);
        return prom;
    }

    parseData(data: Buffer) {
        const datastr = data.toString();
        this.rawReceivedData += datastr;
        while (this.rawReceivedData.includes("\r\n")) {
            let line = this.rawReceivedData.slice(0, this.rawReceivedData.indexOf("\r\n"));
            this.evaluateSocketResponse(line);
            this.rawReceivedData = this.rawReceivedData.slice(this.rawReceivedData.indexOf("\r\n") + 2);
        }
    }

    addStartingBreakpoints() {
        for (const [filePath, brks] of this.breakpointLocations) {
            for (const brk of brks) {
                this.socket?.write(
                    `BRKSET ${filePath} ${brk.line} false ${brk.hitCondition ? parseInt(brk.hitCondition) : 0} ${brk.condition ? brk.condition : "true"}\n`
                );
            }
        }
    }

    evaluateSocketResponse(str: string) {
        const split = str.split(" ");
        if (split.length > 0) {
            const cmd = split[0];
            if (cmd === "COUT") {
                const rest = str.substring(5);
                this.sendEvent(new OutputEvent(rest + "\n", "stdout"));
            }
            if (cmd === "RUNNING") {
                this.sendEvent(new ContinuedEvent(TSDebugSession.threadID, true));
            }
            if (cmd === "BRKCLR") {
                const file = split[1];
                const line = parseInt(split[2]);
                // Need to remove this breakpoint from the list
                if (this.breakpointLocations.has(file)) {
                    const brks = this.breakpointLocations.get(file) || [];
                    const brkToRemove = brks.find((brk) => brk.line === line);
                    if (brkToRemove) {
                        brks.splice(brks.indexOf(brkToRemove), 1);
                        this.breakpointLocations.set(file, brks);
                        // Send event to remove breakpoint
                        const bp = new Breakpoint(false, brkToRemove.line) as DebugProtocol.Breakpoint;
                        bp.id = brkToRemove.breakpointId;
                        this.sendEvent(new BreakpointEvent("removed", bp));
                    }
                }
            }
            if (cmd === "BRKMOV") {
                const file = split[1];
                const line = parseInt(split[2]);
                const newLine = parseInt(split[3]);
                // Need to move this breakpoint
                if (this.breakpointLocations.has(file)) {
                    const brks = this.breakpointLocations.get(file) || [];
                    const brkToMove = brks.find((brk) => brk.line === line);
                    if (brkToMove) {
                        const bp = new Breakpoint(true, newLine) as DebugProtocol.Breakpoint;
                        bp.id = brkToMove.breakpointId;
                        this.sendEvent(new BreakpointEvent("changed", bp));
                        brkToMove.line = newLine;
                    }
                }
            }
            if (cmd === "BREAK") {
                this.stackFrames = [];
                let i = 1;
                while (i < split.length) {
                    const file = split[i++];
                    const line = parseInt(split[i++]);
                    const func = split[i++];
                    this.stackFrames.push({ file, function: func, line });
                }
                const top = this.stackFrames[0];
                // Check if this hit a breakpoint
                if (this.breakpointLocations.has(top.file)) {
                    const brks = this.breakpointLocations.get(top.file) || [];
                    const brk = brks.find((brk) => brk.line === top.line);
                    if (brk) {
                        const ev = new StoppedEvent("breakpoint", TSDebugSession.threadID) as DebugProtocol.StoppedEvent;
                        ev.body.hitBreakpointIds = [brk.breakpointId];
                        this.sendEvent(ev);
                    } else {
                        this.sendEvent(new StoppedEvent("step", TSDebugSession.threadID));
                    }
                } else {
                    this.sendEvent(new StoppedEvent("step", TSDebugSession.threadID));
                }
            }
            if (cmd === "EVALOUT") {
                const tag = split[1];
                const val = split.slice(2).join(" ");
                const resolve = this.varReqPromResolves.get(parseInt(tag));
                if (resolve) {
                    resolve(val);
                    this.varReqPromResolves.delete(parseInt(tag));
                }
            }
        }
        if (this.tryPause) {
            this.sendEvent(new StoppedEvent("pause", TSDebugSession.threadID));
            this.tryPause = false;
        }
    }

    private createSource(filePath: string): Source {
        const fp = this.convertDebuggerPathToClient(filePath);

        // Get current folder
        const curFolder = vscode.workspace.workspaceFolders![0].uri.fsPath;
        // Append fp to curFolder
        const actualPath = this.rootDir === "" || !this.rootDir ? path.join(curFolder, fp) : path.join(curFolder, this.rootDir, fp);

        // let workspaceFolder = vscode.workspace.get
        // if (workspaceFolder) {
        //     filePath = vscode.workspace.asRelativePath(filePath, false);
        // }

        return new Source(basename(filePath), actualPath);
    }
}
