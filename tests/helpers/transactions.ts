import {Page, Response} from "@playwright/test";

export const waitForTransactionAction = (page: Page, action: string, timeout = 30000) =>
    page.waitForResponse(response => {
        if (new URL(response.url()).pathname !== "/api/transactions") {
            return false;
        }
        const payload = response.request().postDataJSON() as {
            transactions?: Array<{
                doOperations?: Array<{action?: string}>;
            }>;
        };
        return payload.transactions?.some(transaction =>
            transaction.doOperations?.some(operation => operation.action === action)) || false;
    }, {timeout});

export const requestTransactionAction = async (
    page: Page,
    action: string,
    trigger: () => Promise<void>,
    timeout = 30000,
): Promise<Response> => {
    const response = waitForTransactionAction(page, action, timeout);
    await trigger();
    return response;
};
