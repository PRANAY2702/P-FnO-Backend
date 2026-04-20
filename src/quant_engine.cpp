#include <napi.h>
#include <cmath>
#include <string>

const double PI = 3.14159265358979323846;

// Standard Normal cumulative distribution function
double norm_cdf(double x) {
    return 0.5 * std::erfc(-x / std::sqrt(2.0));
}

// Standard Normal probability density function
double norm_pdf(double x) {
    return (1.0 / std::sqrt(2.0 * PI)) * std::exp(-0.5 * x * x);
}

// Calculate d1 for BSM
double calculate_d1(double S, double K, double T, double r, double v) {
    return (std::log(S / K) + (r + 0.5 * v * v) * T) / (v * std::sqrt(T));
}

// Calculate d2 for BSM
double calculate_d2(double d1, double v, double T) {
    return d1 - v * std::sqrt(T);
}

// Option Pricing and Greeks functions
Napi::Object CalculateAll(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 6 || !info[0].IsNumber() || !info[1].IsNumber() || 
        !info[2].IsNumber() || !info[3].IsNumber() || !info[4].IsNumber() || !info[5].IsString()) {
        Napi::TypeError::New(env, "Expected (spot, strike, t, r, v, type)").ThrowAsJavaScriptException();
        return Napi::Object::New(env);
    }

    double S = info[0].As<Napi::Number>().DoubleValue(); // Spot price
    double K = info[1].As<Napi::Number>().DoubleValue(); // Strike price
    double T = info[2].As<Napi::Number>().DoubleValue(); // Time to maturity in years
    double r = info[3].As<Napi::Number>().DoubleValue(); // Risk-free rate
    double v = info[4].As<Napi::Number>().DoubleValue(); // Volatility
    std::string type = info[5].As<Napi::String>().Utf8Value(); // "call" or "put"

    double prime = 0.0, delta = 0.0, gamma = 0.0, theta = 0.0, vega = 0.0, rho = 0.0;

    if (T <= 0.0) {
        // Option has expired
        if (type == "call") {
            prime = std::max(S - K, 0.0);
            delta = S > K ? 1.0 : 0.0;
        } else {
            prime = std::max(K - S, 0.0);
            delta = K > S ? -1.0 : 0.0;
        }
    } else {
        double d1 = calculate_d1(S, K, T, r, v);
        double d2 = calculate_d2(d1, v, T);

        gamma = norm_pdf(d1) / (S * v * std::sqrt(T));
        vega = S * norm_pdf(d1) * std::sqrt(T) / 100.0; // Vega per 1% change

        if (type == "call") {
            prime = S * norm_cdf(d1) - K * std::exp(-r * T) * norm_cdf(d2);
            delta = norm_cdf(d1);
            theta = (-S * norm_pdf(d1) * v / (2 * std::sqrt(T)) - r * K * std::exp(-r * T) * norm_cdf(d2)) / 365.0; // Theta per day
            rho = K * T * std::exp(-r * T) * norm_cdf(d2) / 100.0; // Rho per 1% change
        } else if (type == "put") {
            prime = K * std::exp(-r * T) * norm_cdf(-d2) - S * norm_cdf(-d1);
            delta = norm_cdf(d1) - 1.0;
            theta = (-S * norm_pdf(d1) * v / (2 * std::sqrt(T)) + r * K * std::exp(-r * T) * norm_cdf(-d2)) / 365.0; // Theta per day
            rho = -K * T * std::exp(-r * T) * norm_cdf(-d2) / 100.0; // Rho per 1% change
        } else {
            Napi::TypeError::New(env, "Type must be 'call' or 'put'").ThrowAsJavaScriptException();
            return Napi::Object::New(env);
        }
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("premium", prime);
    result.Set("delta", delta);
    result.Set("gamma", gamma);
    result.Set("theta", theta);
    result.Set("vega", vega);
    result.Set("rho", rho);

    return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set(Napi::String::New(env, "calculateAll"),
                Napi::Function::New(env, CalculateAll));
    return exports;
}

NODE_API_MODULE(quant_engine, Init)
