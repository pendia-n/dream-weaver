# model switch

## new dream instance (text and image)

first text input (init message always text only input; but that does not limit user from choosing an image output of 2 to their first message in a new dream instance):
credit < 200: openai/gpt-5-nano
credit >= 200: qwen/qwen3.5-flash-02-23
(user credit - 2 if text only response in first message; user credit - 3 if both text and image response)

subsequent message input:
credit < 300: 
 text only input: amazon/nova-lite-v1
 text and image clicked: openai/gpt-5-nano
credit >= 300: 
 text only input: deepseek/deepseek-v4-flash 
 text and image clicked: meta-llama/llama-4-scout
(
user credit - 1 if text only input with text only output, 
user credit - 3 if text only input with text and image generated,
user credit - 2 if text and image clicked with text only response,
user credit - 4 if text and image clicked with text and image generated
)

## main chat (only text chat)

credit < 400: qwen/qwen3.6-flash
credit >= 400: writer/palmyra-x5
(user credit - 0.5 each input)

## publishing

if share all from a dream instance only as worker to query the init text and all the subsequent ai gen text response to the public board say ai replied 7 times at the time of publishing then 8 messages (init from user and 7 from ai)

if summary:
credit < 500: nvidia/nemotron-3-super
credit >= 500: minimax/minimax-m1

(user credit - 0)

## comment in public board
(user credit - 0)
