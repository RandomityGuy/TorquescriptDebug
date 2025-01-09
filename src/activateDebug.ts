"use strict";

import * as vscode from "vscode";
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from "vscode";
import { TSDebugSession } from "./tsDebug";

export function activateDebug(context: vscode.ExtensionContext) {
    // register a configuration provider for 'torque-debug' debug type
    const provider = new TSDebugConfigurationProvider();
    context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider("torque-debug", provider));

    // register a dynamic configuration provider for torque-debug' debug type
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider(
            "torque-debug",
            {
                provideDebugConfigurations(folder: WorkspaceFolder | undefined): ProviderResult<DebugConfiguration[]> {
                    return [
                        {
                            name: "Attach to Game",
                            request: "attach",
                            type: "torque-debug",
                            address: "localhost",
                            port: 8000,
                            password: "",
                            rootDir: "",
                        },
                    ];
                },
            },
            vscode.DebugConfigurationProviderTriggerKind.Dynamic
        )
    );

    // override VS Code's default implementation of the debug hover
    context.subscriptions.push(
        vscode.languages.registerEvaluatableExpressionProvider("torquescript", {
            provideEvaluatableExpression(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.EvaluatableExpression> {
                const VARIABLE_REGEXP = /[$%][a-z][a-z0-9.:]*/gi;
                const line = document.lineAt(position.line).text;

                let m: RegExpExecArray | null;
                while ((m = VARIABLE_REGEXP.exec(line))) {
                    const varRange = new vscode.Range(position.line, m.index, position.line, m.index + m[0].length);

                    if (varRange.contains(position)) {
                        // Need to stop at the next dot
                        const nextDot = line.indexOf(".", position.character);
                        if (nextDot !== -1 && nextDot < m.index + m[0].length) {
                            return new vscode.EvaluatableExpression(new vscode.Range(position.line, m.index, position.line, nextDot));
                        }

                        return new vscode.EvaluatableExpression(varRange);
                    }
                }
                return undefined;
            },
        })
    );

    let factory = new InlineDebugAdapterFactory();
    context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory("torque-debug", factory));
}

class TSDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    /**
     * Massage a debug configuration just before a debug session is being launched,
     * e.g. add all missing attributes to the debug configuration.
     */
    resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {
        // if launch.json is missing or empty
        if (!config.type && !config.request && !config.name) {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === "torquescript") {
                config.type = "torque-debug";
                config.name = "Attach to Game";
                config.request = "attach";
                config.address = "localhost";
                config.port = 8000;
                config.password = "";
                config.rootDir = "";
            }
        }

        return config;
    }
}

class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
        return new vscode.DebugAdapterInlineImplementation(new TSDebugSession());
    }
}
