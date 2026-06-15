woorden = []
woord = input("Geef een woord:")

while woord != 'xxx':
    woorden.append(woord)
    woord = input("Geef een woord: ")
print("STOP")
print(woorden)


for woord in woorden:  # перебираем слова списка
    print(woord)  # выводим слово

alfabetisch = True
for i in range(len(woorden) - 1):
    if woorden [i] > woorden[i+1]:
        alfabetisch = False 

if alfabetisch:  # если нарушений нет
    print("Woorden staan alfabetisch.")
else:  # если нашли нарушение
    print("Woorden staan niet alfabetisch.")