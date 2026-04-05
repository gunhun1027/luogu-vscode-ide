import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as vscode from 'vscode';

export interface LuoguProblemListItem {
    pid: string;
    title: string;
    difficulty: number;
    fullScore: number;
    type: string;
    tags: any[];
    totalSubmit: number;
    totalAccepted: number;
}

export interface LuoguProblemListResult {
    problems: {
        result: LuoguProblemListItem[];
        count: number;
        perPage: number;
    };
}

export interface LuoguSample {
    input: string;
    output: string;
}

export interface LuoguProblemDetail {
    pid: string;
    title: string;
    difficulty: number;
    background: string;
    description: string;
    inputFormat: string;
    outputFormat: string;
    samples: LuoguSample[];
    hint: string;
    provider: { uid: number; name: string } | null;
    tags: any[];
    limits: {
        time: number[];
        memory: number[];
    };
    totalSubmit: number;
    totalAccepted: number;
}

const DIFFICULTY_MAP: Record<number, { label: string; color: string }> = {
    0: { label: '暂无评定', color: '#bfbfbf' },
    1: { label: '入门', color: '#fe4c61' },
    2: { label: '普及-', color: '#f39c11' },
    3: { label: '普及/提高-', color: '#ffc116' },
    4: { label: '普及+/提高', color: '#52c41a' },
    5: { label: '提高+/省选-', color: '#3498db' },
    6: { label: '省选/NOI-', color: '#9d3dcf' },
    7: { label: 'NOI/NOI+/CTSC', color: '#0e1d69' },
};

export function getDifficultyInfo(difficulty: number): { label: string; color: string } {
    return DIFFICULTY_MAP[difficulty] || DIFFICULTY_MAP[0];
}

async function makeRequest(url: string, headers: Record<string, string>, retries = 3): Promise<any> {
    const proxyUrl = vscode.workspace.getConfiguration('http').get<string>('proxy') || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: headers,
                timeout: 15000,
                redirect: 'follow',
                agent: agent as any
            });
            
            if (!response.ok) {
                throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
            }
            
            const text = await response.text();
            try {
                return JSON.parse(text);
            } catch (e) {
                throw new Error(`JSON解析失败: ${text.substring(0, 200)}`);
            }
        } catch (error: any) {
            if (i === retries - 1) {
                throw error;
            }
            // Wait before retrying (exponential backoff)
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
        }
    }
}

const REQUEST_HEADERS: Record<string, string> = {
    'x-lentille-request': 'content-only',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
};

export async function fetchProblemList(
    page: number = 1,
    type: string = 'P',
    keyword: string = ''
): Promise<LuoguProblemListResult> {
    const params = new URLSearchParams();
    params.set('page', String(page));
    if (type) { params.set('type', type); }
    if (keyword) { params.set('keyword', keyword); }
    
    const result = await makeRequest(`https://www.luogu.com.cn/problem/list?${params.toString()}`, REQUEST_HEADERS);
    return (result.currentData || result.data) as LuoguProblemListResult;
}

export async function fetchProblemDetail(pid: string): Promise<LuoguProblemDetail> {
    const result = await makeRequest(`https://www.luogu.com.cn/problem/${pid}`, REQUEST_HEADERS);
    const data = result.currentData || result.data;
    
    if (!data || !data.problem) {
        throw new Error(`题目 ${pid} 不存在或数据格式错误`);
    }
    
    const problem = data.problem;
    
    // 洛谷 API 的内容在 content 或 contenu 对象中
    const content = problem.content || problem.contenu || {};
    
    // 转换样例格式: [[input, output], ...] -> [{input, output}, ...]
    const rawSamples: any[] = problem.samples || [];
    const samples: LuoguSample[] = rawSamples.map((s: any[]) => ({
        input: s[0] || '',
        output: s[1] || '',
    }));
    
    return {
        pid: problem.pid || pid,
        title: problem.title || '',
        difficulty: problem.difficulty ?? 0,
        background: content.background || '',
        description: content.description || '',
        inputFormat: content.formatI || '',
        outputFormat: content.formatO || '',
        samples: samples,
        hint: content.hint || '',
        provider: problem.provider ? { uid: problem.provider.uid, name: problem.provider.name } : null,
        tags: problem.tags || [],
        limits: problem.limits || { time: [1000], memory: [131072] },
        totalSubmit: problem.totalSubmit ?? 0,
        totalAccepted: problem.totalAccepted ?? 0,
    };
}
